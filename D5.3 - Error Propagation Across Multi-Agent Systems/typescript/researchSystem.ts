/**
 * Research system shared by the D5.3 demos: search subagents, recovery policy, synthesis.
 *
 * A search subagent returns a structured result envelope:
 *
 *   status            success | partial | failed
 *   failure_type      timeout | rate_limited | access_denied | not_found | null
 *   retryable         whether the failure type is transient
 *   attempted_query   exactly what was tried, and where (source)
 *   attempts          [{attempt, outcome, backoff_ms}] - local recovery that already happened
 *   results           findings (a success with zero results is a VALID empty result)
 *   partial_results   whatever was gathered before the failure
 *   alternatives      recovery options the subagent can see (narrower query, other source, retry later)
 *
 * Transient failures (timeout, rate_limited) are retried locally with exponential backoff;
 * only what the subagent cannot resolve is propagated. Access failures are not retried
 * locally because retrying cannot help, so they go straight to the coordinator.
 *
 * The other subagent variants are the anti-patterns from sample question 8.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import * as lab from "../../shared/typescript/labkit.ts";

export interface Finding {
  title: string;
  url: string;
  date: string;
  finding: string;
}
export interface Alternative {
  action: string;
  source?: string;
  query?: string;
  after_seconds?: number;
}
export interface Attempt {
  attempt: number;
  outcome: string;
  backoff_ms: number;
}
export interface Envelope {
  subtopic: string;
  status: string;
  source?: string;
  attempted_query?: string;
  attempts?: Attempt[];
  failure_type?: string | null;
  retryable?: boolean;
  results?: Finding[];
  match_count?: number;
  partial_results?: Finding[];
  alternatives?: Alternative[];
  message?: string;
}
export interface SearchRequest {
  subtopic: string;
  source: string;
  query: string;
}
interface Behaviour {
  attempts: string[];
  results?: Finding[];
  partial?: Finding[];
  alternatives?: Alternative[];
}

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/research_sources.json", import.meta.url), "utf-8")) as {
  topic: string;
  plan: SearchRequest[];
  behaviour: Record<string, Behaviour>;
};
export const TOPIC = FIXTURE.topic;
export const PLAN = FIXTURE.plan;

export const TRANSIENT = ["timeout", "rate_limited"];
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;
const RETRY_BUDGET_S = 300; // the coordinator will not wait longer than this for a source

/** Raised by the "propagate the exception" anti-pattern. */
export class SearchFailed extends Error {}

const behaviourFor = (source: string, query: string): Behaviour => FIXTURE.behaviour[`${source}|${query}`] ?? { attempts: ["ok"], results: [] };
const attemptOutcome = (b: Behaviour, attempt: number) => b.attempts[Math.min(attempt, b.attempts.length) - 1];

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/** Correct: recover locally from transient failures, propagate the rest WITH context. */
export function structuredSubagent(subtopic: string, source: string, query: string): Envelope {
  const behaviour = behaviourFor(source, query);
  const attempts: Attempt[] = [];
  let outcome = "ok";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    outcome = attemptOutcome(behaviour, attempt);
    const retry = TRANSIENT.includes(outcome) && attempt < MAX_ATTEMPTS;
    // A real subagent sleeps for backoff_ms here; the lab only records it.
    attempts.push({ attempt, outcome, backoff_ms: retry ? BASE_BACKOFF_MS * 2 ** (attempt - 1) : 0 });
    if (outcome === "ok" || !retry) break; // success, or a failure that retrying cannot fix (access_denied, not_found)
  }
  const base = { subtopic, source, attempted_query: query, attempts };
  if (outcome === "ok") {
    const results = behaviour.results ?? [];
    return { ...base, status: "success", failure_type: null, retryable: false, results, match_count: results.length, partial_results: [], alternatives: [] };
  }
  const partial = behaviour.partial ?? [];
  return {
    ...base,
    status: partial.length ? "partial" : "failed",
    failure_type: outcome,
    retryable: TRANSIENT.includes(outcome),
    results: [],
    partial_results: partial,
    alternatives: behaviour.alternatives ?? [],
  };
}

/** ANTI-PATTERN (Q8 option C): catch the failure and return an empty result marked success. */
export function suppressingSubagent(subtopic: string, source: string, query: string): Envelope {
  const env = structuredSubagent(subtopic, source, query);
  return { subtopic, source, status: "success", results: env.status === "success" ? env.results : [] };
}

/** ANTI-PATTERN (Q8 option B): retry internally, then report only "search unavailable". */
export function genericSubagent(subtopic: string, source: string, query: string): Envelope {
  const env = structuredSubagent(subtopic, source, query);
  if (env.status !== "success") return { subtopic, status: "error", message: "search unavailable" };
  return { subtopic, source, status: "success", results: env.results };
}

/** ANTI-PATTERN (Q8 option D): let the failure escape to a top-level handler. */
export function raisingSubagent(subtopic: string, source: string, query: string): Envelope {
  const env = structuredSubagent(subtopic, source, query);
  if (env.status !== "success") throw new SearchFailed(`${source} failed for ${subtopic}`);
  return env;
}

export type Subagent = (subtopic: string, source: string, query: string) => Envelope;

// ---------------------------------------------------------------------------
// Coordinator recovery policy (uses only what the envelope tells it)
// ---------------------------------------------------------------------------

export const RECOVERY_ACTIONS = ["narrow_query", "alternative_source", "retry_same"];

export interface Decision {
  action: string;
  reason: string;
  source?: string;
  query?: string;
}

export function decideRecovery(env: Envelope, request: SearchRequest, recoveredAlready: boolean): Decision {
  if (env.status === "success") {
    const n = (env.results ?? []).length;
    return { action: "accept", reason: n ? `${n} result(s)` : "valid empty result: the search worked, nothing exists" };
  }
  const partial = (env.partial_results ?? []).length > 0;
  if (recoveredAlready) return { action: partial ? "proceed_with_partial" : "record_gap", reason: "recovery already attempted" }; // keeps the run bounded
  if (!("failure_type" in env)) {
    // Generic status: no failure type, no query, no alternatives. All it can do is retry blindly.
    return { action: "retry_same", source: request.source, query: request.query, reason: "no detail; blind retry" };
  }
  const failure = env.failure_type ?? "";
  const alternatives = env.alternatives ?? [];
  const option = (action: string) => alternatives.find((a) => a.action === action);
  const narrow = option("narrow_query");
  const otherSource = option("alternative_source");
  const later = option("retry_later");
  if (failure === "timeout" && narrow) return { action: "narrow_query", source: env.source, query: narrow.query, reason: "broad query timed out" };
  if ((failure === "access_denied" || failure === "not_found") && otherSource) {
    return { action: "alternative_source", source: otherSource.source, query: env.attempted_query, reason: `${failure} on ${env.source}` };
  }
  if (later && (later.after_seconds ?? Infinity) <= RETRY_BUDGET_S) {
    return { action: "retry_same", source: env.source, query: env.attempted_query, reason: "source asked us to wait briefly" };
  }
  if (otherSource) return { action: "alternative_source", source: otherSource.source, query: env.attempted_query, reason: failure };
  return { action: partial ? "proceed_with_partial" : "record_gap", reason: `${failure}; no recovery fits the ${RETRY_BUDGET_S}s budget` };
}

export function coverageDecision(envs: Envelope[]): string {
  const final = envs[envs.length - 1];
  if (final.status === "success") {
    if (!(final.results ?? []).length) return "no_data";
    return envs.length > 1 ? "recovered" : "accept";
  }
  return (final.partial_results ?? []).length ? "proceed_with_partial" : "gap";
}

// ---------------------------------------------------------------------------
// Synthesis with coverage annotations
// ---------------------------------------------------------------------------

export function coverageStatus(final: Envelope): string {
  if (final.status === "success") {
    const n = (final.results ?? []).length;
    return n >= 2 ? "well-supported" : n === 1 ? "limited: 1 source" : "no published data";
  }
  if (final.status === "partial") return "gap: partial results";
  if (final.status === "failed") return "gap: source unavailable";
  return "gap: unknown error";
}

export function coverageNote(envs: Envelope[]): string {
  const parts: string[] = [];
  envs.forEach((env, i) => {
    const attempts = env.attempts ?? [];
    const failed = attempts.filter((a) => a.outcome !== "ok").map((a) => a.outcome);
    if (env.status === "success") {
      if (failed.length) parts.push(`${env.source} recovered locally after ${failed.length}x ${failed[0]}`);
      if (i > 0) parts.push(`recovered via ${env.source} '${env.attempted_query}'`);
      if (env.match_count === 0) parts.push(`${env.source} search succeeded with 0 matches`);
    } else if ("failure_type" in env) {
      parts.push(`${env.source} ${env.failure_type} after ${attempts.length} attempt(s)`);
      const partial = env.partial_results ?? [];
      if (i === envs.length - 1 && partial.length) parts.push(`proceeding with ${partial.length} partial result(s)`);
    } else {
      parts.push(env.message ?? "error");
    }
  });
  return parts.join("; ");
}

function title(subtopic: string): string {
  const text = subtopic.replaceAll("_", " ");
  return text.slice(0, 1).toUpperCase() + text.slice(1).toLowerCase();
}

export interface CoverageRow {
  subtopic: string;
  status: string;
  sources: number;
  note: string;
  findings: number;
}

/** Render the report and return its coverage rows. */
export function synthesize(history: Map<string, Envelope[]>): { report: string; rows: CoverageRow[] } {
  const sections: string[] = [];
  const rows: CoverageRow[] = [];
  for (const [subtopic, envs] of history) {
    const final = envs[envs.length - 1];
    const results = final.results ?? [];
    const findings = results.length ? results : final.partial_results ?? [];
    const status = coverageStatus(final);
    rows.push({ subtopic, status, sources: findings.length, note: coverageNote(envs), findings: findings.length });
    sections.push(`### ${title(subtopic)} (${status})`);
    for (const r of findings) sections.push(`- ${r.finding} [${r.title}, ${r.date}]`);
    if (status === "no published data") sections.push(`- The ${final.source ?? "source"} search succeeded and found no published data on this.`);
    else if (!findings.length) sections.push("- No findings: see the coverage table.");
    sections.push("");
  }
  const table = ["| subtopic | coverage | sources | note |", "|---|---|---|---|", ...rows.map((r) => `| ${r.subtopic} | ${r.status} | ${r.sources} | ${r.note} |`)];
  const report = `# ${TOPIC}\n\n## Findings\n\n` + sections.join("\n") + "\n## Coverage\n\n" + table.join("\n");
  return { report, rows };
}

// ---------------------------------------------------------------------------
// The coordinator as a Claude agent (delegate_search + submit_coverage tools)
// ---------------------------------------------------------------------------

export const COORDINATOR_PROMPT =
  `You coordinate research on '${TOPIC}'. Delegate each subtopic with delegate_search; you may send ` +
  "several delegate_search calls in one turn. Each result is a structured envelope with status " +
  "(success | partial | failed), failure_type, attempted_query, attempts, results, partial_results and " +
  "alternatives. Rules: a success with zero results is a valid finding (nothing exists); do not retry it. " +
  "On failure, choose a recovery from the envelope: narrow the query after a timeout, use an alternative " +
  "source after access_denied, and proceed with the partial results (annotating the gap) when no recovery " +
  `fits a ${RETRY_BUDGET_S}-second budget. At most one recovery per subtopic. When every subtopic is ` +
  "settled, call submit_coverage with one decision per subtopic.";

export const COORDINATOR_TOOLS: Anthropic.Tool[] = [
  {
    name: "delegate_search",
    description: "Run a search subagent for one subtopic on one source. Returns a structured result envelope.",
    input_schema: {
      type: "object",
      properties: {
        subtopic: { type: "string" },
        source: { type: "string", enum: ["web_search", "academic_db", "news_archive", "industry_reports"] },
        query: { type: "string" },
      },
      required: ["subtopic", "source", "query"],
    },
  },
  {
    name: "submit_coverage",
    description: "Finish: record the coverage decision for every subtopic before synthesis.",
    input_schema: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subtopic: { type: "string" },
              decision: { type: "string", enum: ["accept", "recovered", "proceed_with_partial", "no_data", "gap"] },
              note: { type: "string" },
            },
            required: ["subtopic", "decision", "note"],
          },
        },
      },
      required: ["decisions"],
    },
  },
];

/** Every envelope (in order) per subtopic, plus the last request sent for each subtopic. */
function envelopeHistory(params: lab.CreateParams): { history: Map<string, Envelope[]>; requests: Map<string, SearchRequest> } {
  const history = new Map<string, Envelope[]>();
  const requests = new Map<string, SearchRequest>();
  for (const msg of params.messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (msg.role === "assistant" && block.type === "tool_use" && block.name === "delegate_search") {
        const request = block.input as SearchRequest;
        requests.set(request.subtopic, request);
      }
      if (msg.role === "user" && block.type === "tool_result") {
        const data = JSON.parse(lab.toolResultText(block)) as Partial<Envelope>;
        if (data.subtopic !== undefined) {
          const envs = history.get(data.subtopic) ?? [];
          envs.push(data as Envelope);
          history.set(data.subtopic, envs);
        }
      }
    }
  }
  return { history, requests };
}

export function scriptedCoordinator(params: lab.CreateParams): Anthropic.Message {
  const called = lab.allToolCalls(params);
  if (!called.length) {
    // fan out: one assistant turn, six delegations
    return lab.message([lab.text("Delegating all six subtopics in parallel."), ...PLAN.map((p) => lab.toolUse("delegate_search", { ...p }))]);
  }
  if (called.includes("submit_coverage")) return lab.message([lab.text("Coverage submitted; handing over to synthesis.")]);
  const { history, requests } = envelopeHistory(params);
  const recoveries: Anthropic.ToolUseBlock[] = [];
  for (const [subtopic, envs] of history) {
    const request = requests.get(subtopic);
    if (!request) continue;
    const decision = decideRecovery(envs[envs.length - 1], request, envs.length > 1);
    if (RECOVERY_ACTIONS.includes(decision.action)) {
      recoveries.push(lab.toolUse("delegate_search", { subtopic, source: decision.source, query: decision.query }));
    }
  }
  if (recoveries.length) {
    return lab.message([lab.text(`Recovering ${recoveries.length} subtopic(s) using the envelopes' alternatives.`), ...recoveries]);
  }
  const decisions = [...history.entries()].map(([subtopic, envs]) => ({
    subtopic,
    decision: coverageDecision(envs),
    note: coverageNote(envs) || "first attempt succeeded",
  }));
  return lab.message([lab.toolUse("submit_coverage", { decisions })]);
}
