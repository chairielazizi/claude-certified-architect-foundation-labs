/**
 * Provenance-preserving synthesis shared by the D5.6 demos.
 *
 * Subagents return structured claim-source mappings:
 *   {claim_key, subtopic, content_type, claim, value, unit, evidence_excerpt,
 *    source_url, document_name, publication_date, data_collection_period, methodology}
 *
 * The synthesis step never turns these into free text first. It:
 *   1. merges mappings by claim_key, then by value: the same claim from several sources
 *      becomes ONE finding with several citations;
 *   2. classifies each group: established (one value), temporal (values differ but the data
 *      periods do not overlap), or conflict (different values for the same period);
 *   3. completes the analysis with conflicts annotated (both values, both sources) and leaves
 *      reconciliation to the coordinator;
 *   4. renders each content type in its natural form: financial data as a table, news as
 *      prose, technical findings as a bulleted list, every claim with its citations.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import * as lab from "../../shared/typescript/labkit.ts";

export interface Claim {
  claim_key: string;
  subtopic: string;
  content_type: string;
  claim: string;
  value: string | null;
  unit: string | null;
  evidence_excerpt: string;
  source_url: string;
  document_name: string;
  publication_date: string;
  data_collection_period: string | null;
  methodology: string;
  agent: string;
}
export interface Variant {
  value: string | null;
  unit: string | null;
  claim: string;
  citations: Claim[];
}
export interface Group {
  claim_key: string;
  subtopic: string;
  content_type: string;
  variants: Variant[];
  status: string;
}
export interface Conflict {
  claim_key: string;
  status: string;
  values: { value: string | null; unit: string | null; sources: string[]; documents: string[]; periods: string[]; methodologies: string[] }[];
}
export interface Analysis {
  groups: Group[];
  conflicts: Conflict[];
  gaps: string[];
  index: Map<string, string>;
}
export interface Decision {
  claim_key: string;
  decision: string;
  rationale: string;
}

export const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/subagent_outputs.json", import.meta.url), "utf-8")) as {
  topic: string;
  requested_subtopics: string[];
  subagents: { agent: string; claims: Omit<Claim, "agent">[] }[];
};
export const TOPIC = FIXTURE.topic;
const REQUESTED = FIXTURE.requested_subtopics;

export function allClaims(): Claim[] {
  return FIXTURE.subagents.flatMap((sub) => sub.claims.map((c) => ({ ...c, agent: sub.agent })));
}

/** Stable citation ids [S1], [S2] ... in order of first appearance. */
export function sourceIndex(claims: Claim[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of claims) if (!index.has(c.source_url)) index.set(c.source_url, `S${index.size + 1}`);
  return index;
}

// ---------------------------------------------------------------------------
// Merge and classify
// ---------------------------------------------------------------------------

function merge(claims: Claim[]): Group[] {
  const groups = new Map<string, Group>();
  for (const c of claims) {
    let group = groups.get(c.claim_key);
    if (!group) {
      group = { claim_key: c.claim_key, subtopic: c.subtopic, content_type: c.content_type, variants: [], status: "" };
      groups.set(c.claim_key, group);
    }
    let variant = group.variants.find((v) => v.value === c.value);
    if (!variant) {
      variant = { value: c.value, unit: c.unit, claim: c.claim, citations: [] };
      group.variants.push(variant);
    }
    variant.citations.push(c); // keep the whole mapping: url, excerpt, dates, methodology
  }
  return [...groups.values()];
}

export function periods(variant: Variant): string[] {
  const out = new Set<string>();
  for (const c of variant.citations) if (c.data_collection_period) out.add(c.data_collection_period);
  return [...out].sort();
}

function classify(group: Group): string {
  if (group.variants.length === 1) return "established";
  const seen = new Set<string>();
  for (const v of group.variants) {
    const p = periods(v);
    if (!p.length || p.some((x) => seen.has(x))) return "conflict"; // same (or unknown) period, different values
    p.forEach((x) => seen.add(x));
  }
  return "temporal"; // every value comes from a different period: a change over time
}

/** Completes even when sources disagree: conflicts are annotated, never resolved or dropped here. */
export function analyze(claims: Claim[]): Analysis {
  const index = sourceIndex(claims);
  const groups = merge(claims);
  const conflicts: Conflict[] = [];
  for (const group of groups) {
    group.status = classify(group);
    if (group.status !== "conflict") continue;
    conflicts.push({
      claim_key: group.claim_key,
      status: "unresolved",
      values: group.variants.map((v) => ({
        value: v.value,
        unit: v.unit,
        sources: v.citations.map((c) => index.get(c.source_url) ?? "?"),
        documents: v.citations.map((c) => c.document_name),
        periods: periods(v),
        methodologies: v.citations.map((c) => c.methodology),
      })),
    });
  }
  const covered = new Set(groups.map((g) => g.subtopic));
  return { groups, conflicts, gaps: REQUESTED.filter((s) => !covered.has(s)), index };
}

// ---------------------------------------------------------------------------
// Coordinator reconciliation (a model call with a tool)
// ---------------------------------------------------------------------------

const COORDINATOR_PROMPT =
  "You are the research coordinator. The analysis step found conflicting values from credible sources. " +
  "For each conflict call record_reconciliation. Do not pick a value arbitrarily: if the sources use " +
  "different methodologies, report both with their methodology; if a source is clearly unreliable, say " +
  "which to prefer and why; otherwise request a third source.";
const RECONCILE_TOOL: Anthropic.Tool = {
  name: "record_reconciliation",
  description: "Record how the report should present one conflict.",
  input_schema: {
    type: "object",
    properties: {
      claim_key: { type: "string" },
      decision: { type: "string", enum: ["report_both_with_methodology", "prefer_source", "seek_third_source"] },
      rationale: { type: "string" },
    },
    required: ["claim_key", "decision", "rationale"],
  },
};

function scriptedCoordinator(params: lab.CreateParams): Anthropic.Message {
  if (lab.toolResults(params).length) return lab.message([lab.text("Reconciliation recorded for every conflict.")]);
  const text = lab.lastUserText(params);
  const conflicts = JSON.parse(text.slice(text.indexOf("\n") + 1)) as Conflict[];
  const calls = conflicts.map((conflict) => {
    const methods = new Set(conflict.values.flatMap((v) => v.methodologies));
    return methods.size > 1
      ? lab.toolUse("record_reconciliation", {
          claim_key: conflict.claim_key,
          decision: "report_both_with_methodology",
          rationale: "Both sources are credible and cover the same period; the gap is explained by different inclusion rules.",
        })
      : lab.toolUse("record_reconciliation", {
          claim_key: conflict.claim_key,
          decision: "seek_third_source",
          rationale: "Same methodology, different values: a third source is needed.",
        });
  });
  return lab.message([lab.text("Reviewing the annotated conflicts."), ...calls]);
}

/** Coordinator loop: the model decides, the decisions come back as structured tool input. */
export async function reconcile(client: lab.MessagesClient, conflicts: Conflict[]): Promise<Map<string, Decision>> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Conflicts from the analysis step (JSON):\n" + JSON.stringify(conflicts, null, 2) },
  ];
  const decisions = new Map<string, Decision>();
  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 16000,
      system: COORDINATOR_PROMPT,
      tools: [RECONCILE_TOOL],
      messages: [...messages],
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return decisions;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of lab.toolUses(response)) {
      const input = block.input as Decision;
      decisions.set(input.claim_key, { ...input });
      results.push({ type: "tool_result", tool_use_id: block.id, content: "recorded" });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("coordinator did not finish");
}

// ---------------------------------------------------------------------------
// Naive summarization (the anti-pattern)
// ---------------------------------------------------------------------------

const NAIVE_PROMPT = "Summarize these research findings into one concise paragraph.";

const naiveInput = (claims: Claim[]) => claims.map((c) => `- ${c.claim} (source: ${c.document_name}, ${c.source_url})`).join("\n");

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9%]+/g) ?? []);

function sameTopic(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return shared * 10 >= 4 * union; // word overlap (Jaccard) >= 0.4, in integer math
}

/** Compresses to one sentence per topic: the first claim wins and attribution disappears. */
function scriptedSummarizer(params: lab.CreateParams): Anthropic.Message {
  const kept: string[] = [];
  for (const line of lab.lastUserText(params).split("\n")) {
    const claim = line.slice(2).split(" (source:")[0];
    if (!kept.some((k) => sameTopic(claim, k))) kept.push(claim);
  }
  return lab.message([lab.text(kept.join(" "))]);
}

export async function summarizeNaively(client: lab.MessagesClient, claims: Claim[]): Promise<string> {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system: NAIVE_PROMPT,
    messages: [{ role: "user", content: naiveInput(claims) }],
  });
  return lab.textOf(response);
}

export function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  return lab.systemText(params).startsWith(NAIVE_PROMPT) ? scriptedSummarizer(params) : scriptedCoordinator(params);
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const LABELS: Record<string, string> = { ai_music_funding_2026h1: "AI music startup funding" };

export const cites = (variant: Variant, index: Map<string, string>) => variant.citations.map((c) => `[${index.get(c.source_url)}]`).join(" ");

export function renderReport(analysis: Analysis, decisions: Map<string, Decision>): string {
  const { index, groups } = analysis;
  const settled = groups.filter((g) => g.status === "established" || g.status === "temporal");
  const lines = [`# ${TOPIC}`, "", "## Well-established findings", "", "### Financial data", "", "| Finding | Value | Data period | Sources |", "|---|---|---|---|"];
  const notes: string[] = [];
  for (const g of settled.filter((g) => g.content_type === "financial")) {
    for (const v of g.variants) lines.push(`| ${v.claim} | ${v.value} ${v.unit} | ${periods(v).join(", ")} | ${cites(v, index)} |`);
    if (g.status === "temporal") {
      const byPeriod = g.variants.map((v) => `${periods(v).join(", ")}: ${v.value}`).join("; ");
      notes.push(`Temporal difference, not a contradiction: ${g.claim_key} changes with the data period (${byPeriod}).`);
    }
  }
  lines.push("", ...notes, "", "### News", "");
  const news = settled.filter((g) => g.content_type === "news").flatMap((g) => g.variants.map((v) => `${v.claim.replace(/\.+$/, "")} ${cites(v, index)}.`));
  lines.push(news.join(" "), "", "### Technical findings", "");
  for (const g of settled.filter((g) => g.content_type === "technical")) {
    for (const v of g.variants) lines.push(`- ${v.claim} ${cites(v, index)} (method: ${v.citations.map((c) => c.methodology).join("; ")})`);
  }
  lines.push("", "## Contested findings", "");
  for (const conflict of analysis.conflicts) {
    const sides = conflict.values
      .map((v) => `${v.value} ${v.unit} per ${v.documents.join(" and ")} [${v.sources.join("] [")}] (${v.methodologies.join("; ")})`)
      .join(" vs ");
    const decision = decisions.get(conflict.claim_key);
    const verdict = decision ? ` Coordinator decision: ${decision.decision}. ${decision.rationale}` : " Coordinator decision: pending.";
    const period = [...new Set(conflict.values.flatMap((v) => v.periods))].sort().join(", ");
    lines.push(`- ${LABELS[conflict.claim_key] ?? conflict.claim_key} (${period}): ${sides}.${verdict}`);
  }
  lines.push("", "## Coverage gaps", "");
  if (analysis.gaps.length) lines.push(...analysis.gaps.map((gap) => `- ${gap}: no subagent returned a sourced claim.`));
  else lines.push("- none");
  lines.push("", "## Sources", "");
  const byUrl = new Map<string, Claim>();
  for (const g of groups) for (const v of g.variants) for (const c of v.citations) byUrl.set(c.source_url, c);
  for (const [url, sid] of index) {
    const c = byUrl.get(url);
    if (!c) continue;
    lines.push(`- [${sid}] ${c.document_name}. ${url}. Published ${c.publication_date}; data ${c.data_collection_period ?? "n/a"}; method: ${c.methodology}.`);
  }
  return lines.join("\n");
}

/** Lines of one section, up to the next heading of the same or a higher level. */
export function section(report: string, title: string, level = "## "): string {
  const out: string[] = [];
  let inside = false;
  for (const line of report.split("\n")) {
    if (line.startsWith(level) || line.startsWith("## ") || line.startsWith("# ")) {
      inside = line === level + title;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** Every rendered claim: table rows, bullets and prose sentences in the findings sections. */
export function claimUnits(report: string): string[] {
  const units: string[] = [];
  for (const title of ["Well-established findings", "Contested findings"]) {
    for (const line of section(report, title).split("\n")) {
      if (line.startsWith("| ") && !line.startsWith("| Finding")) units.push(line);
      else if (line.startsWith("- ")) units.push(line);
      else if (line && !line.startsWith("#") && !line.startsWith("|") && !line.startsWith("Temporal difference")) {
        units.push(...(line.match(/.+?(?:\.(?=\s|$)|$)/g) ?? []).filter((s) => s.trim()));
      }
    }
  }
  return units;
}
