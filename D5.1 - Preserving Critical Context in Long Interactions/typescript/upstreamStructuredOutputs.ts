/**
 * D5.1 - Upstream agents return structured data when downstream context is limited.
 *
 * Four research subagents report to a synthesis step that has a small context budget.
 * Verbose reports (working logs, reasoning chains, caveats buried in prose) do not fit, so
 * whole reports get truncated or dropped. The same findings as structured data - key
 * facts with relevance scores, citations (source, location, date) and a one-line
 * methodology - fit with room to spare and keep the metadata synthesis needs.
 *
 * The change is made UPSTREAM, in the subagent's instructions and output format, not by
 * asking the downstream agent to read faster.
 *
 * Run:  npx tsx upstreamStructuredOutputs.ts          (offline)
 *       npx tsx upstreamStructuredOutputs.ts --live   (real subagents; structured outputs via output_config)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { loadFixture, type AgentFindings, type Fact } from "./contextLayers.ts";

const FINDINGS = loadFixture("subagent_findings.json") as { question: string; agents: AgentFindings[] };
const SYNTHESIS_BUDGET_CHARS = 6000;

const VERBOSE_PROMPT = "You are a research subagent. Report your findings to the coordinator.";
const STRUCTURED_PROMPT =
  "You are a research subagent. The coordinator's synthesis step has a small context budget, so " +
  "return ONLY structured data: your scope, a one-line methodology, and key facts. Each key fact has " +
  "an id, the fact, a relevance score 0-100 for the research question, and its citation (source, " +
  "location, date). No reasoning, no working log, no prose.";
const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    agent: { type: "string" },
    scope: { type: "string" },
    methodology: { type: "string" },
    key_facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          fact: { type: "string" },
          relevance: { type: "integer" },
          source: { type: "string" },
          location: { type: "string" },
          date: { type: "string" },
        },
        required: ["id", "fact", "relevance", "source", "location", "date"],
        additionalProperties: false,
      },
    },
  },
  required: ["agent", "scope", "methodology", "key_facts"],
  additionalProperties: false,
};

const verboseReport = (a: AgentFindings) => a.working_log.join("\n") + "\n\n" + a.verbose;
const structuredReport = (a: AgentFindings) => ({ agent: a.agent, scope: a.scope, methodology: a.methodology, key_facts: a.facts });

function subagentTask(a: AgentFindings): string {
  // In live mode the subagent condenses its own working notes; offline the scripted
  // subagent returns the fixture's report in whichever format the prompt asks for.
  return (
    `Research question: ${FINDINGS.question}\nAgent: ${a.agent}\nScope: ${a.scope}\n` +
    `Methodology: ${a.methodology}\n\nYour working notes:\n${verboseReport(a)}`
  );
}

function scriptedSubagent(params: lab.CreateParams): Anthropic.Message {
  const task = lab.lastUserText(params);
  const agent = FINDINGS.agents.find((a) => task.includes(`Agent: ${a.agent}\n`));
  if (!agent) throw new Error("unknown subagent task");
  if (lab.systemText(params).includes("return ONLY structured data")) {
    return lab.message([lab.text(JSON.stringify(structuredReport(agent)))]);
  }
  return lab.message([lab.text(verboseReport(agent))]);
}

async function runSubagent(client: lab.MessagesClient, a: AgentFindings, structured: boolean): Promise<string> {
  const params: Record<string, unknown> = {
    model: lab.MODEL,
    max_tokens: 16000,
    system: structured ? STRUCTURED_PROMPT : VERBOSE_PROMPT,
    messages: [{ role: "user", content: subagentTask(a) }],
  };
  // Structured outputs: the first text block is guaranteed to be JSON matching the schema.
  if (structured) params.output_config = { format: { type: "json_schema", schema: FINDINGS_SCHEMA } };
  const text = lab.textOf(await client.messages.create(params as unknown as lab.CreateParams));
  return structured ? JSON.stringify(JSON.parse(text)) : text;
}

/** What a context-limited synthesis step actually receives: reports in arrival order until the budget runs out. */
function packIntoBudget(reports: [string, string][], budget: number): { packed: string; fate: Record<string, string> } {
  const parts: string[] = [];
  const fate: Record<string, string> = {};
  let remaining = budget;
  for (const [name, report] of reports) {
    if (report.length <= remaining) {
      parts.push(report);
      fate[name] = "complete";
      remaining -= report.length;
    } else if (remaining > 0) {
      parts.push(report.slice(0, remaining));
      fate[name] = `truncated to ${remaining} of ${report.length} chars`;
      remaining = 0;
    } else {
      fate[name] = "dropped";
    }
  }
  return { packed: parts.join("\n\n"), fate };
}

lab.banner("D5.1  Upstream agents return structured data for a limited downstream budget");
console.log(`question: ${FINDINGS.question}`);
console.log(`synthesis context budget: ${SYNTHESIS_BUDGET_CHARS.toLocaleString("en-US")} chars`);

const contexts: Record<string, string> = {};
const totals: Record<string, number> = {};
for (const [key, title, structured] of [
  ["verbose", "A - verbose reports", false],
  ["structured", "B - structured key facts", true],
] as const) {
  lab.section(title);
  const client = lab.getClient(scriptedSubagent);
  const reports: [string, string][] = [];
  for (const a of FINDINGS.agents) reports.push([a.agent, await runSubagent(client, a, structured)]);
  totals[key] = reports.reduce((sum, [, r]) => sum + r.length, 0);
  const { packed, fate } = packIntoBudget(reports, SYNTHESIS_BUDGET_CHARS);
  contexts[key] = packed;
  for (const [name, report] of reports) console.log(`  ${name.padEnd(18)} ${report.length.toLocaleString("en-US").padStart(6)} chars -> ${fate[name]}`);
  console.log(`  total ${totals[key].toLocaleString("en-US")} chars`);
  if (structured) {
    const example = (JSON.parse(reports[1][1]) as { key_facts: Fact[] }).key_facts[3];
    lab.show("  one structured fact (note the citation metadata)", example);
  }
}

lab.section("Checks");
console.log(`  structured / verbose = ${Math.floor((totals.structured * 100) / totals.verbose)}%`);
lab.check(totals.structured <= SYNTHESIS_BUDGET_CHARS, "all four structured reports fit the synthesis budget");
if (!lab.isLive()) {
  lab.check(totals.verbose > SYNTHESIS_BUDGET_CHARS, "the verbose reports do not fit, so later reports get truncated or dropped");
  lab.check(totals.structured * 10 <= totals.verbose * 6, "structured output is at most 60% of the verbose size, with more information kept");
  lab.check(!contexts.verbose.includes("44%"), "verbose: the exit survey's top finding (44% 'too expensive') never reached synthesis");
  const everyId = FINDINGS.agents.flatMap((a) => a.facts.map((f) => f.id));
  lab.check(everyId.every((i) => contexts.structured.includes(`"id":"${i}"`)), "structured: every fact reached synthesis with its id");
  lab.check(contexts.structured.split('"source":').length - 1 === everyId.length, "structured: every fact carries its source, location and date");
}
