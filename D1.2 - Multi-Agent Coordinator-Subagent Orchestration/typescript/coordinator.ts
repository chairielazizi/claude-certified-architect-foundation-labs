/**
 * D1.2 - Hub-and-spoke coordinator: dynamic routing, partitioned delegation, iterative refinement.
 *
 *   query -> plan()                coordinator's own LLM call: how complex? which subagents? which slices?
 *         -> validateCoverage()    programmatic check of the decomposition (see scopePartitioning.ts)
 *         -> delegate(web_search | document_analysis)   one slice x one source type per call
 *         -> refine(): delegate(synthesis) -> structured gaps -> targeted re-delegation -> repeat
 *         -> delegate(report)
 *
 * Every subagent call goes through Coordinator.delegate(): the one place that builds the isolated
 * request, writes the event log and applies the error policy.
 *
 * Run:  npx tsx coordinator.ts          (offline, scripted subagents)
 *       npx tsx coordinator.ts --live   (every role is a real messages.create call)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { feedbackFor, validateCoverage, type CoverageReport } from "./coverageValidator.ts";
import {
  COORDINATOR_PROMPT,
  OUTPUT_SCHEMAS,
  ROLES,
  SUBAGENT_PROMPTS,
  jsonOutput,
  roleOf,
  scriptedTeam,
  type Finding,
  type Gap,
  type RawFinding,
  type ResearchRole,
  type Role,
  type Subtopic,
  type Synthesis,
} from "./researchTeam.ts";

export const MAX_PLAN_ATTEMPTS = 3;
// Bounded refinement: if coverage is still short after this many synthesis passes, throw.
// Publishing a report with a silent hole is worse than failing loudly.
export const MAX_REFINEMENT_ROUNDS = 3;

/** Partitioning by source type: search and analysis never fetch the same kind of source. */
export const SOURCE_TYPES: Record<ResearchRole, [string, string]> = {
  web_search: ["web", "news and web articles only; reports and papers are assigned to document_analysis"],
  document_analysis: ["documents", "research reports and academic papers only; news is assigned to web_search"],
};
const SHORT: Record<ResearchRole, string> = { web_search: "web", document_analysis: "docs" };

/**
 * A Messages API request plus output_config (structured outputs). The intersection keeps this
 * compiling whether or not the installed SDK version declares output_config on its params type.
 */
export type ApiRequest = lab.CreateParams & { output_config?: unknown };

export interface Plan {
  complexity: "simple" | "broad";
  rationale: string;
  subagents: Role[];
  subtopics: Subtopic[];
  coverage?: CoverageReport;
}
export interface SubagentResult {
  role: Role;
  taskId: string;
  ok: boolean;
  data?: unknown;
  error?: Record<string, unknown>;
}
export interface CoordinatorEvent {
  seq: number;
  event: string;
  role: string;
  task: string;
  detail: string;
}
export interface Outcome {
  plan: Plan;
  route: Role[];
  rounds: number;
  answer: string;
}

function describeGaps(gaps: Gap[]): string {
  return gaps.map((g) => `${g.dimension} (${g.missing})`).join(", ") || "synthesis never succeeded";
}

export class CoverageNotConverged extends Error {
  readonly rounds: number;
  readonly gaps: Gap[];
  constructor(rounds: number, gaps: Gap[]) {
    super(`coverage still insufficient after ${rounds} refinement rounds: ${describeGaps(gaps)}`);
    this.name = "CoverageNotConverged";
    this.rounds = rounds;
    this.gaps = gaps;
  }
}

/** Raised for replies that are not usable output (wrong stop_reason). */
class InvalidOutputError extends Error {}

/**
 * Map any subagent failure to [errorType, retryable]. Matching class names along the prototype
 * chain mirrors the Python lab and covers SDK errors (RateLimitError, APIConnectionTimeoutError ...).
 */
export function classifyError(err: unknown): [string, boolean] {
  const names = new Set<string>();
  let proto = err !== null && typeof err === "object" ? Object.getPrototypeOf(err) : null;
  while (proto) {
    names.add(String(proto.constructor?.name));
    proto = Object.getPrototypeOf(proto);
  }
  const has = (...candidates: string[]) => candidates.some((c) => names.has(c));
  if (has("TimeoutError", "APIConnectionTimeoutError")) return ["timeout", true];
  if (has("RateLimitError", "APIConnectionError", "InternalServerError")) return ["transient", true];
  if (has("SyntaxError", "InvalidOutputError")) return ["invalid_output", true]; // JSON.parse failures
  return ["unexpected", false];
}

function citation(raw: RawFinding): string {
  if (raw.source_url !== undefined) return `${raw.title}, ${raw.source_url} (${raw.publication_date})`;
  return `${raw.document_name}, p. ${raw.page} (${raw.publication_date})`;
}

export function sliceTask(topic: string, focus: string, role: ResearchRole, note = ""): string {
  const lines = [`<topic>${topic}</topic>`, `<slice>${focus}</slice>`, `<source_type>${SOURCE_TYPES[role][1]}</source_type>`];
  if (note) lines.push(`<note>${note}</note>`);
  lines.push("Research only this slice and source type; other agents cover the rest. Return your findings as JSON.");
  return lines.join("\n");
}

export function synthesisTask(topic: string, required: string[], findings: Finding[]): string {
  return [
    `<topic>${topic}</topic>`,
    `<required_dimensions>${JSON.stringify(required)}</required_dimensions>`,
    "<findings>",
    JSON.stringify(findings, null, 1),
    "</findings>",
    "Combine the findings into key points per dimension and report coverage gaps as JSON.",
  ].join("\n");
}

export function reportTask(topic: string, synthesis: Synthesis, findings: Finding[]): string {
  const sources = findings.map((f) => ({ id: f.id, citation: f.citation }));
  return [
    `<topic>${topic}</topic>`,
    `<synthesis>${JSON.stringify(synthesis)}</synthesis>`,
    `<sources>${JSON.stringify(sources)}</sources>`,
    "Write the final report.",
  ].join("\n");
}

function summarize(role: Role, data: unknown): string {
  if (role === "web_search" || role === "document_analysis") {
    return `${(data as { findings: unknown[] }).findings.length} finding(s)`;
  }
  if (role === "synthesis") {
    const s = data as Synthesis;
    return `${s.key_points.length} key point(s), ${s.coverage_gaps.length} gap(s), sufficient=${s.coverage_sufficient}`;
  }
  return `report, ${String(data).split("\n").length} lines`;
}

/** The hub. Subagents never talk to each other; everything flows through these methods. */
export class Coordinator {
  history: Anthropic.MessageParam[] = []; // the coordinator's OWN conversation (planning turns)
  plans: Plan[] = [];
  events: CoordinatorEvent[] = []; // observability: every plan, delegation and outcome
  subagentRequests: ApiRequest[] = []; // exactly what each subagent was sent
  findings: Finding[] = []; // aggregated results, tagged by the coordinator

  constructor(private readonly client: lab.MessagesClient) {}

  log(event: string, role: string, task: string, detail: string): void {
    this.events.push({ seq: this.events.length + 1, event, role, task, detail });
  }

  // -- planning: decide complexity, route and decomposition -------------------

  async plan(query: string): Promise<Plan> {
    this.history = [{ role: "user", content: query }];
    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
      const params: ApiRequest = {
        model: lab.MODEL,
        max_tokens: 16000,
        system: COORDINATOR_PROMPT,
        output_config: jsonOutput("coordinator"),
        messages: this.history,
      };
      const response = await this.client.messages.create(params);
      this.history.push({ role: "assistant", content: response.content });
      const plan = JSON.parse(lab.textOf(response)) as Plan;
      this.plans.push(plan);
      this.log("plan", "coordinator", `plan-${attempt}`,
        `${plan.complexity}; route=${JSON.stringify(plan.subagents)}; ${plan.subtopics.length} slice(s)`);
      if (plan.complexity === "simple") return plan;
      const coverage = validateCoverage(query, plan.subtopics);
      const verdict = coverage.ok ? "ok" : `missing=${JSON.stringify(coverage.missing)} overlaps=${JSON.stringify(coverage.overlaps)}`;
      this.log("validate", "coordinator", `plan-${attempt}`, verdict);
      if (coverage.ok) {
        plan.coverage = coverage;
        return plan;
      }
      // A too-narrow decomposition is the coordinator's bug, so the feedback goes to the
      // coordinator, not to the downstream agents (sample question 7).
      this.history.push({ role: "user", content: feedbackFor(coverage) });
    }
    throw new Error(`No decomposition passed the coverage check in ${MAX_PLAN_ATTEMPTS} attempts`);
  }

  // -- the single entry point for every subagent call ---------------------------

  async delegate(role: Role, task: string, taskId: string, detail: string): Promise<SubagentResult> {
    const params: ApiRequest = {
      model: lab.MODEL,
      max_tokens: 16000,
      system: SUBAGENT_PROMPTS[role],
      // A fresh one-message conversation: the subagent sees its task and nothing else.
      // this.history is never passed; whatever a subagent needs must be written into `task`.
      messages: [{ role: "user", content: task }],
    };
    if (role in OUTPUT_SCHEMAS) params.output_config = jsonOutput(role);
    this.subagentRequests.push(params);
    this.log("delegate", role, taskId, detail);
    let data: unknown;
    try {
      const response = await this.client.messages.create(params);
      if (response.stop_reason !== "end_turn") {
        throw new InvalidOutputError(`incomplete response (stop_reason=${response.stop_reason})`);
      }
      data = role in OUTPUT_SCHEMAS ? JSON.parse(lab.textOf(response)) : lab.textOf(response);
    } catch (err) {
      // One consistent policy for every subagent failure.
      const [kind, retryable] = classifyError(err);
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 160);
      this.log("error", role, taskId, `${kind} (retryable=${retryable}): ${message}`);
      return { role, taskId, ok: false, error: { role, task_id: taskId, type: kind, retryable, message } };
    }
    this.log("result", role, taskId, summarize(role, data));
    return { role, taskId, ok: true, data };
  }

  /** Delegate one research assignment and aggregate its findings (the coordinator tags them). */
  async gather(topic: string, focus: string, role: ResearchRole, dimension: string, taskId: string, note = ""): Promise<SubagentResult> {
    const result = await this.delegate(role, sliceTask(topic, focus, role, note), taskId, focus);
    if (result.ok) {
      for (const raw of (result.data as { findings: RawFinding[] }).findings) {
        this.findings.push({
          id: `F${this.findings.length + 1}`,
          dimension,
          source_type: SOURCE_TYPES[role][0],
          claim: raw.claim,
          citation: citation(raw),
        });
      }
    }
    return result;
  }

  // -- iterative refinement -----------------------------------------------------

  /** Synthesis judges coverage; the coordinator closes each gap with a targeted delegation. */
  async refine(topic: string, required: string[]): Promise<{ synthesis: Synthesis; rounds: number }> {
    let gaps: Gap[] = [];
    for (let round = 1; round <= MAX_REFINEMENT_ROUNDS; round++) {
      const result = await this.delegate("synthesis", synthesisTask(topic, required, this.findings), `synth-r${round}`,
        `${this.findings.length} findings`);
      if (!result.ok) continue; // already logged by delegate(); the next round retries synthesis
      const synthesis = result.data as Synthesis;
      if (synthesis.coverage_sufficient) return { synthesis, rounds: round };
      gaps = synthesis.coverage_gaps;
      if (round === MAX_REFINEMENT_ROUNDS) break; // no synthesis pass left to use new findings
      this.log("refine", "coordinator", `round-${round}`,
        gaps.map((g) => `${g.dimension}: ${g.missing} -> ${g.target_role}`).join("; "));
      for (const [i, gap] of gaps.entries()) {
        await this.gather(topic, gap.suggested_query, gap.target_role, gap.dimension, `gap-r${round}.${i + 1}`,
          `Follow-up for a coverage gap in ${gap.dimension}: ${gap.missing}.`);
      }
    }
    throw new CoverageNotConverged(MAX_REFINEMENT_ROUNDS, gaps);
  }

  // -- the whole run ----------------------------------------------------------------

  async research(query: string): Promise<Outcome> {
    const plan = await this.plan(query);
    const route = ROLES.filter((role) => plan.subagents.includes(role)); // dynamic selection, not a fixed pipeline
    const coverage = plan.coverage;
    const sliceDims = coverage ? coverage.slice_dimensions : {};
    // Scope partitioning: one assignment per slice x source type, so no two calls overlap.
    for (const st of plan.subtopics) {
      const dims = sliceDims[st.id];
      const dimension = dims && dims.length ? dims[0] : st.id;
      for (const role of ["web_search", "document_analysis"] as const) {
        if (route.includes(role)) await this.gather(query, st.focus, role, dimension, `${st.id}/${SHORT[role]}`);
      }
    }

    if (!route.includes("synthesis")) {
      // Simple route: the coordinator answers straight from the search result.
      const answer = this.findings.map((f) => `${f.claim} [${f.citation}]`).join(" ") || "No answer found.";
      return { plan, route, rounds: 0, answer };
    }

    const required = coverage && coverage.required.length ? coverage.required : [...new Set(this.findings.map((f) => f.dimension))].sort();
    const { synthesis, rounds } = await this.refine(query, required);
    let answer = JSON.stringify(synthesis, null, 2);
    if (route.includes("report")) {
      const report = await this.delegate("report", reportTask(query, synthesis, this.findings), "report", "final report");
      if (report.ok) answer = String(report.data);
    }
    return { plan, route, rounds, answer };
  }
}

// ---------------------------------------------------------------------------
// Inspection helpers used by the demos' checks
// ---------------------------------------------------------------------------

/** Print the event log (optionally only the events `keep` selects). */
export function printEvents(coordinator: Coordinator, keep?: (e: CoordinatorEvent) => boolean): void {
  for (const e of coordinator.events) {
    if (!keep || keep(e)) {
      console.log(`  ${String(e.seq).padStart(2, "0")} ${e.event.padEnd(8)} ${e.role.padEnd(17)} ${e.task.padEnd(10)} ${e.detail}`);
    }
  }
}

/** Subagent requests that carry anything from the coordinator's own conversation. */
export function isolationViolations(coordinator: Coordinator): string[] {
  const privateText = [COORDINATOR_PROMPT, ...coordinator.plans.map((p) => p.rationale)];
  const problems: string[] = [];
  for (const req of coordinator.subagentRequests) {
    const blob = JSON.stringify(req);
    if (req.messages.length !== 1) problems.push(`${roleOf(req)}: ${req.messages.length} messages instead of 1`);
    if (privateText.some((p) => blob.includes(p))) problems.push(`${roleOf(req)}: contains coordinator-private text`);
  }
  return problems;
}

/** True if any delegation lacks exactly one matching result/error event. */
export function unpairedDelegations(coordinator: Coordinator): boolean {
  const delegated = coordinator.events.filter((e) => e.event === "delegate").map((e) => e.task).sort();
  const outcomes = coordinator.events.filter((e) => e.event === "result" || e.event === "error").map((e) => e.task).sort();
  return JSON.stringify(delegated) !== JSON.stringify(outcomes);
}

async function main(): Promise<void> {
  lab.banner("D1.2  Coordinator-subagent orchestration (hub-and-spoke)");

  const queries: [string, string][] = [
    ["A - simple factual query", "When did the EU AI Act enter into force?"],
    ["B - broad research topic", "impact of AI on creative industries"],
  ];
  const runs: Record<string, { coordinator: Coordinator; outcome: Outcome }> = {};
  for (const [title, query] of queries) {
    lab.section(title);
    console.log(`query: ${query}`);
    const coordinator = new Coordinator(lab.getClient(scriptedTeam));
    const outcome = await coordinator.research(query);
    runs[title] = { coordinator, outcome };
    console.log(`route chosen by the coordinator: ${JSON.stringify(outcome.route)}   refinement rounds: ${outcome.rounds}`);
    for (const st of outcome.plan.subtopics) console.log(`  slice ${st.id}: ${st.focus}`);
    console.log("event log (every delegation and every result passed through the coordinator):");
    printEvents(coordinator);
    console.log("answer:\n  " + outcome.answer.replaceAll("\n", "\n  "));

    lab.check(isolationViolations(coordinator).length === 0, "every subagent call was a fresh 1-message conversation with no coordinator history");
    lab.check(!unpairedDelegations(coordinator), "every delegation has exactly one logged result or error");
    if (!lab.isLive() && title.startsWith("A")) {
      lab.check(JSON.stringify(outcome.route) === '["web_search"]' && coordinator.subagentRequests.length === 1,
        "simple factual query -> web_search only (1 subagent call, no synthesis or report)");
    }
    if (!lab.isLive() && title.startsWith("B")) {
      lab.check(JSON.stringify(outcome.route) === JSON.stringify(ROLES), "broad topic -> full pipeline: search, analysis, synthesis, report");
      lab.check(outcome.rounds === 2, "synthesis reported a gap in round 1; the targeted follow-up closed it in round 2");
      lab.check(outcome.answer.includes("VFX Workforce Study"), "the report cites the document found only by the targeted follow-up");
    }
  }

  lab.section("What one subagent actually received");
  const coordinatorB = runs["B - broad research topic"].coordinator;
  const first = coordinatorB.subagentRequests[0];
  console.log(`system: ${lab.systemText(first).split("\n")[0]} ...`);
  console.log(`messages (${first.messages.length}):`);
  const content = first.messages[0].content;
  console.log("  user: " + (typeof content === "string" ? content : JSON.stringify(content)).replaceAll("\n", "\n        "));
  console.log(`coordinator's own history at the end: ${coordinatorB.history.length} message(s), none of them sent to any subagent`);

  if (!lab.isLive()) {
    const routeA = JSON.stringify(runs["A - simple factual query"].outcome.route);
    const routeB = JSON.stringify(runs["B - broad research topic"].outcome.route);
    lab.check(routeA !== routeB, "the coordinator picked different subagents for different queries");
  }
}

// Run main() only when executed directly (the other demos import Coordinator).
if (lab.isMain(import.meta.url)) {
  await main();
}
