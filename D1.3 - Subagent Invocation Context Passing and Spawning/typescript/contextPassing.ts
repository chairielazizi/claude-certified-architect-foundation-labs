/**
 * D1.3 - Passing context to a subagent: complete structured findings vs a prose summary.
 *
 * A subagent starts with an EMPTY context. The synthesizer can only cite what its prompt contains,
 * so the coordinator passes the complete prior findings, with content and source metadata in
 * separate fields:
 *
 *   {"finding_id": "D2", "agent": "doc-analyst",
 *    "content":  {"claim": "...", "evidence": "..."},
 *    "metadata": {"source_url": null, "document_name": "...", "page": 31, "publication_date": "2026-06-01"}}
 *
 * The anti-pattern is a prose recap ("earlier research found that ..."): every claim survives,
 * every source is gone, and two conflicting figures can no longer be told apart.
 *
 * Run:  npx tsx contextPassing.ts          (offline)
 *       npx tsx contextPassing.ts --live   (the synthesizer is a real messages.create call)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { AGENT_SPECS, TOPIC } from "./agentDefinitions.ts";

export interface ResearchFinding {
  finding_id: string;
  agent: string;
  content: { claim: string; evidence: string };
  metadata: { source_url: string | null; document_name: string | null; page: number | null; publication_date: string };
}

/**
 * What web-researcher and doc-analyst returned earlier in the session (fictional data).
 * W2 and D2 disagree on purpose: only attribution lets a reader weigh them.
 */
export const FINDINGS: ResearchFinding[] = [
  {
    finding_id: "W1",
    agent: "web-researcher",
    content: {
      claim: "Two major record labels signed licensing deals with AI music start-ups in 2026.",
      evidence: "The agreements license back catalogues for model training ...",
    },
    metadata: { source_url: "https://example.org/news/labels-license-ai-music", document_name: null, page: null, publication_date: "2026-04-02" },
  },
  {
    finding_id: "D1",
    agent: "doc-analyst",
    content: {
      claim: "Licensed AI-training deals made up 6% of music publishing income in 2025.",
      evidence: "... up from under 1% in 2023.",
    },
    metadata: { source_url: null, document_name: "Music Rights Review 2026", page: 7, publication_date: "2026-02-15" },
  },
  {
    finding_id: "W2",
    agent: "web-researcher",
    content: {
      claim: "A trade-press survey found 40% of VFX studios use generative AI in production.",
      evidence: "Four in ten studios told the survey they use generative tools ...",
    },
    metadata: { source_url: "https://example.org/news/vfx-genai-survey", document_name: null, page: null, publication_date: "2026-05-30" },
  },
  {
    finding_id: "D2",
    agent: "doc-analyst",
    content: {
      claim: "28% of surveyed VFX studios report using generative AI tools in production work.",
      evidence: "Rotoscoping and clean-up are the most automated tasks.",
    },
    metadata: { source_url: null, document_name: "Screen Industries VFX Workforce Study", page: 31, publication_date: "2026-06-01" },
  },
];

const stripPeriods = (s: string) => s.replace(/\.+$/, "");

export function sourceOf(finding: ResearchFinding): string {
  const meta = finding.metadata;
  if (meta.source_url) return `${meta.source_url} (${meta.publication_date})`;
  return `${meta.document_name}, p. ${meta.page} (${meta.publication_date})`;
}

/** BAD: the coordinator "helpfully" recaps earlier work in prose. */
export function proseHandoff(topic: string, findings: ResearchFinding[]): string {
  const recap = findings.map((f) => stripPeriods(f.content.claim)).join("; ");
  return `Write a research briefing on: ${topic}\nBackground from earlier research: ${recap}.`;
}

/** GOOD: the complete findings, content separated from metadata, plus how to use them. */
export function structuredHandoff(topic: string, findings: ResearchFinding[]): string {
  const records = "[\n" + findings.map((f) => JSON.stringify(f)).join(",\n") + "\n]";
  return (
    `Write a research briefing on: ${topic}\n\n` +
    "You have no other context. The findings below are the complete output of the web-researcher and " +
    "doc-analyst subagents. Each one separates content (claim, evidence) from metadata (source_url, " +
    "document_name, page, publication_date).\n" +
    "Cite every claim with its finding_id and source. If two findings disagree, present both values " +
    "with their sources.\n\n" +
    `<findings>\n${records}\n</findings>`
  );
}

export function findingsIn(prompt: string): ResearchFinding[] {
  const block = prompt.match(/<findings>\s*([\s\S]*?)\s*<\/findings>/);
  return block ? (JSON.parse(block[1]) as ResearchFinding[]) : [];
}

/** Per original finding: is its claim in the prompt, and is it still tied to its own source? */
export function attributionReport(prompt: string, findings: ResearchFinding[]): Record<string, { claimPresent: boolean; sourceAttached: boolean }> {
  const passed = new Map(findingsIn(prompt).map((f) => [f.content.claim, f.metadata] as const));
  const report: Record<string, { claimPresent: boolean; sourceAttached: boolean }> = {};
  for (const f of findings) {
    report[f.finding_id] = {
      claimPresent: prompt.includes(stripPeriods(f.content.claim)),
      sourceAttached: JSON.stringify(passed.get(f.content.claim)) === JSON.stringify(f.metadata),
    };
  }
  return report;
}

/** Offline synthesizer: it can only cite what its prompt gives it, same as the real subagent. */
export function scriptedSynthesizer(params: lab.CreateParams): Anthropic.Message {
  const prompt = lab.lastUserText(params);
  const passed = findingsIn(prompt);
  let lines: string[];
  if (passed.length === 0) {
    const recap = stripPeriods(prompt.split("Background from earlier research:").slice(-1)[0].trim());
    lines = ["Briefing (from background notes; no sources were provided):", ...recap.split("; ").map((s) => `- ${s}.`)];
  } else {
    lines = ["Briefing:", ...passed.map((f) => `- ${f.content.claim} [${f.finding_id}: ${sourceOf(f)}]`)];
  }
  return lab.message([lab.text(lines.join("\n"))]);
}

/** The synthesizer as a subagent: its own system prompt and a fresh one-message conversation. */
export async function runSynthesizer(client: lab.MessagesClient, prompt: string): Promise<string> {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system: AGENT_SPECS.synthesizer.prompt,
    messages: [{ role: "user", content: prompt }],
  });
  return lab.textOf(response);
}

async function main(): Promise<void> {
  lab.banner("D1.3  Context passing: complete, structured findings for the synthesizer");

  lab.section("Prior findings (returned earlier by web-researcher and doc-analyst)");
  for (const f of FINDINGS) {
    console.log(`  ${f.finding_id} ${f.agent.padEnd(14)} ${f.content.claim}`);
    console.log(`     source: ${sourceOf(f)}`);
  }

  const bad = proseHandoff(TOPIC, FINDINGS);
  const good = structuredHandoff(TOPIC, FINDINGS);

  lab.section("BAD: prose summary in the synthesizer's prompt");
  console.log(bad);
  const badReport = Object.values(attributionReport(bad, FINDINGS));
  lab.check(badReport.every((r) => r.claimPresent), "every claim made it into the prose recap ...");
  lab.check(!badReport.some((r) => r.sourceAttached), "... but 0 of 4 claims are still tied to a source");

  lab.section("GOOD: complete findings as JSON, content separate from metadata");
  console.log(good);
  const goodReport = Object.values(attributionReport(good, FINDINGS));
  const passed = findingsIn(good);
  const metadataKeys = JSON.stringify(["document_name", "page", "publication_date", "source_url"]);
  lab.check(goodReport.every((r) => r.claimPresent && r.sourceAttached), "4 of 4 claims are still tied to their own source");
  lab.check(passed.every((f) => Boolean(f.content && f.metadata) && JSON.stringify(Object.keys(f.metadata).sort()) === metadataKeys),
    "every finding keeps content (claim, evidence) and metadata in separate fields");
  lab.check(JSON.stringify(passed) === JSON.stringify(FINDINGS), "the COMPLETE findings were passed; nothing was summarised away");

  lab.section("What the synthesizer subagent writes from each prompt");
  const client = lab.getClient(scriptedSynthesizer);
  const outputs: Record<string, string> = {};
  for (const [label, prompt] of [["prose prompt", bad], ["structured prompt", good]] as const) {
    outputs[label] = await runSynthesizer(client, prompt);
    console.log(`[${label}]\n  ` + outputs[label].replaceAll("\n", "\n  "));
  }

  if (!lab.isLive()) {
    const sources = FINDINGS.map((f) => f.metadata.source_url ?? f.metadata.document_name ?? "");
    lab.check(!sources.some((s) => outputs["prose prompt"].includes(s)), "from the prose prompt the synthesizer can cite nothing");
    lab.check(sources.every((s) => outputs["structured prompt"].includes(s)), "from the structured prompt every claim in the briefing is cited");
    const lines = outputs["structured prompt"].split("\n");
    const line40 = lines.find((l) => l.includes("40%")) ?? "";
    const line28 = lines.find((l) => l.includes("28%")) ?? "";
    lab.check(line40.includes("vfx-genai-survey") && line28.includes("VFX Workforce Study"),
      "the conflicting VFX figures (40% vs 28%) stay side by side, each with its own source");
  }
}

// Run main() only when executed directly (parallelSpawning.ts imports the handoff builders).
if (lab.isMain(import.meta.url)) {
  await main();
}
