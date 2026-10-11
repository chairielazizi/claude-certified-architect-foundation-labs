/**
 * D5.1 - Position-aware aggregation: key findings first, explicit section headers.
 *
 * Models reliably use the beginning and end of a long input but can miss findings in the
 * middle ("lost in the middle"). When aggregating subagent results for a synthesis step:
 *
 *   - put a key-findings summary at the BEGINNING (highest relevance first, with citations)
 *   - organise the detailed results under explicit section headers, one per source
 *
 * Offline, the synthesis model is a deliberately simple positional reader: it attends to
 * the first 25% and the last 15% of its input, plus the first line under each markdown
 * header. That caricature of the effect makes the difference visible and deterministic.
 * In live mode the real model reads the same two inputs.
 *
 * Run:  npx tsx positionAwareAggregation.ts          (offline)
 *       npx tsx positionAwareAggregation.ts --live   (real API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { loadFixture, type AgentFindings, type Fact } from "./contextLayers.ts";

const FINDINGS = loadFixture("subagent_findings.json") as { question: string; agents: AgentFindings[] };
const TOP_N = 4;
const SYSTEM = "You are the synthesis agent. Name the main drivers of the churn increase and cite the fact ids you rely on.";

const factLine = (f: Fact) => `- [${f.id}] ${f.fact} (relevance ${f.relevance}; ${f.source}, ${f.location}, ${f.date})`;

/** Results concatenated in arrival order: no summary, no headers. */
function buildNaive(agents: AgentFindings[]): string {
  return agents.flatMap((a) => a.facts.map(factLine)).join("\n");
}

function buildPositionAware(agents: AgentFindings[], topN = TOP_N): string {
  const ranked = agents.flatMap((a) => a.facts).sort((x, y) => y.relevance - x.relevance); // stable on ties
  const lines = ["## Key findings (highest relevance first)", ...ranked.slice(0, topN).map(factLine), "", "## Detailed results"];
  for (const a of agents) lines.push("", `### ${a.agent}: ${a.scope}`, `Methodology: ${a.methodology}`, ...a.facts.map(factLine));
  return lines.join("\n");
}

/** The simulated reader's attention: head, tail, and the line right under each header. */
function attendedLines(text: string): string[] {
  const lines = text.split("\n");
  const total = text.length;
  let offset = 0;
  const seen: string[] = [];
  lines.forEach((line, i) => {
    const start = offset;
    offset += line.length + 1;
    const inHead = start * 100 < total * 25;
    const inTail = start * 100 >= total * 85;
    const underHeader = i > 0 && lines[i - 1].startsWith("#");
    if (inHead || inTail || underHeader) seen.push(line);
  });
  return seen;
}

const FACT_RE = /^- \[([A-Z]\d+)\] (.+?) \(relevance (\d+);/gm;

function scriptedSynthesizer(params: lab.CreateParams): Anthropic.Message {
  const found = new Map<string, [number, string]>();
  for (const m of attendedLines(lab.lastUserText(params)).join("\n").matchAll(FACT_RE)) found.set(m[1], [Number(m[3]), m[2]]);
  const drivers = [...found.entries()]
    .filter(([, [relevance]]) => relevance >= 70)
    .sort((a, b) => b[1][0] - a[1][0] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!drivers.length) return lab.message([lab.text("I could not identify a clear driver.")]);
  return lab.message([lab.text("Main drivers: " + drivers.map(([id, [, fact]]) => `[${id}] ${fact}`).join(" "))]);
}

async function synthesize(client: lab.MessagesClient, aggregated: string): Promise<string> {
  const content = `Question: ${FINDINGS.question}\n\n${aggregated}`;
  const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system: SYSTEM, messages: [{ role: "user", content }] });
  return lab.textOf(response);
}

lab.banner("D5.1  Position-aware aggregation (mitigating lost-in-the-middle)");
const agents = FINDINGS.agents;
const naive = buildNaive(agents);
const aware = buildPositionAware(agents);
const critical = "[T4]";
const position = Math.floor((naive.indexOf(critical) * 100) / naive.length);
console.log(`most relevant finding ${critical} sits at ${position}% of the naive input (${naive.length.toLocaleString("en-US")} chars)`);

lab.section("A - naive concatenation");
console.log(naive.split("\n").slice(0, 3).join("\n") + "\n  ...");
const naiveAnswer = await synthesize(lab.getClient(scriptedSynthesizer), naive);
console.log(`synthesis: ${naiveAnswer}`);

lab.section("B - key findings first + section headers");
console.log(aware.split("\n").slice(0, 8).join("\n") + "\n  ...");
const awareAnswer = await synthesize(lab.getClient(scriptedSynthesizer), aware);
console.log(`synthesis: ${awareAnswer}`);

lab.section("Checks");
const headers = aware.split("\n").filter((line) => line.startsWith("### "));
lab.check(aware.startsWith("## Key findings"), "B: the key-findings summary is the very first thing in the input");
lab.check(
  aware.indexOf("## Detailed results") > aware.indexOf(critical) && headers.length === agents.length,
  "B: the top finding is inside the summary, and every subagent's detail has its own header",
);
lab.check(position > 25 && position < 85, "A: the most relevant finding sits in the middle of the naive input");
if (!lab.isLive()) {
  lab.check(!naiveAnswer.includes(critical), "A: the positional reader missed the most relevant finding");
  lab.check(["T4", "S1", "B1", "T1"].every((i) => awareAnswer.includes(`[${i}]`)), "B: all four top findings made it into the synthesis");
}
