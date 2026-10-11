/**
 * Agent-side recovery policy for MCP tool errors (D2.2).
 *
 * A subagent calls tools through callStructured(), which reads the error envelope and
 * decides locally:
 *   transient + isRetryable -> wait (retryAfterSeconds or exponential backoff), retry the SAME call
 *   validation              -> fix the input if a deterministic fixer exists, else ask for input
 *   business                -> never retry; hand customerMessage to whoever talks to the customer
 *   permission              -> never retry; escalate to someone with the right access
 *   still failing           -> stop and propagate to the coordinator WITH partial results and
 *                              the list of attempts, so it can decide what to do next
 *
 * With a generic "Operation failed" the agent cannot tell these apart. It can only guess:
 * callRetryAll (recovers timeouts but wastes retries on permanent errors) or callNoRetry
 * (wastes nothing but gives up on timeouts it could have survived).
 */
import type { Handler, LogEntry, ToolResult } from "./supportServer.ts";

export const MAX_ATTEMPTS = 3; // per tool call, including the first one
const BASE_BACKOFF_S = 0.5;
const SLEEP_SCALE = 0.01; // the demo really waits, but only 1% of the backoff so it stays fast

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Offline the "server" is the handler map; over MCP this would be client.callTool(). */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
export const callerFor = (handlers: Record<string, Handler>): CallTool => (name, args) => handlers[name](args);

export function resultText(result: ToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** The structured error body, or null if the server sent something unstructured. */
export function parseEnvelope(result: ToolResult): Record<string, unknown> | null {
  try {
    const body = JSON.parse(resultText(result)) as unknown;
    if (body !== null && typeof body === "object" && "errorCategory" in body) return body as Record<string, unknown>;
  } catch {
    // not JSON -> unstructured
  }
  return null;
}

// Validation errors carry details (field, expected_format, received). Where a correction is
// deterministic, the subagent fixes the input itself; otherwise it asks, never guesses.
type Fixer = (args: Record<string, unknown>, details: Record<string, unknown>) => Record<string, unknown> | null;

export const fixOrderId: Fixer = (args, details) => {
  if (details.field !== "order_id") return null;
  const digits = String(args.order_id ?? "").replace(/\D/g, "");
  return digits.length === 4 ? { ...args, order_id: `ORD-${digits}` } : null;
};

const FIXERS: Record<string, Fixer> = { lookup_order: fixOrderId, process_refund: fixOrderId };

export interface Attempt {
  tool: string;
  args: Record<string, unknown>;
  outcome: string;
  then?: string;
}

export interface Outcome {
  tool: string;
  status: string; // ok | recovered | input_fixed | business_rule | escalate | needs_input | unresolved
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  customerMessage?: string;
  attempts: Attempt[];
}

/** A business-rule refusal is a resolved outcome: we know the answer and how to explain it. */
export const isResolved = (o: Outcome) => ["ok", "recovered", "input_fixed", "business_rule"].includes(o.status);

export async function callStructured(call: CallTool, tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const attempts: Attempt[] = [];
  let current: Record<string, unknown> = { ...args };
  let transientFailures = 0;
  while (true) {
    const result = await call(tool, current);
    if (!result.isError) {
      attempts.push({ tool, args: current, outcome: "ok" });
      const status = attempts.length === 1 ? "ok" : same(current, args) ? "recovered" : "input_fixed";
      return { tool, status, result: JSON.parse(resultText(result)) as Record<string, unknown>, attempts };
    }

    const envelope = parseEnvelope(result);
    if (!envelope) {
      // Unstructured error from a server we don't control: don't guess, propagate.
      attempts.push({ tool, args: current, outcome: "unstructured" });
      return { tool, status: "unresolved", error: { message: resultText(result) }, attempts };
    }

    const category = String(envelope.errorCategory);
    const attempt: Attempt = { tool, args: current, outcome: category };
    attempts.push(attempt);

    if (category === "transient" && envelope.isRetryable === true) {
      transientFailures++;
      if (attempts.length >= MAX_ATTEMPTS) return { tool, status: "unresolved", error: envelope, attempts };
      const wait = Math.max(Number(envelope.retryAfterSeconds ?? 0), BASE_BACKOFF_S * 2 ** (transientFailures - 1));
      attempt.then = `wait ${wait}s and retry`;
      await sleep(wait * SLEEP_SCALE);
      continue;
    }

    if (category === "validation") {
      const fixer = FIXERS[tool];
      const details = (envelope.details ?? {}) as Record<string, unknown>;
      const fixed = fixer ? fixer(current, details) : null;
      if (fixed && !same(fixed, current) && attempts.length < MAX_ATTEMPTS) {
        attempt.then = `call again with corrected input ${JSON.stringify(fixed)}`;
        current = fixed;
        continue;
      }
      return { tool, status: "needs_input", error: envelope, attempts };
    }

    if (category === "business") {
      const customerMessage = typeof envelope.customerMessage === "string" ? envelope.customerMessage : undefined;
      return { tool, status: "business_rule", error: envelope, customerMessage, attempts };
    }

    if (category === "permission") return { tool, status: "escalate", error: envelope, attempts };

    return { tool, status: "unresolved", error: envelope, attempts };
  }
}

/** Blind policy for generic errors: every failure might be transient, so retry it. */
export async function callRetryAll(call: CallTool, tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const attempts: Attempt[] = [];
  let last = "";
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const result = await call(tool, args);
    attempts.push({ tool, args: { ...args }, outcome: result.isError ? "error" : "ok" });
    if (!result.isError) {
      return { tool, status: n === 1 ? "ok" : "recovered", result: JSON.parse(resultText(result)) as Record<string, unknown>, attempts };
    }
    last = resultText(result);
    if (n < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_S * 2 ** (n - 1) * SLEEP_SCALE);
  }
  return { tool, status: "unresolved", error: { message: last }, attempts };
}

/** Blind policy for generic errors: every failure might be permanent, so give up. */
export async function callNoRetry(call: CallTool, tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const result = await call(tool, args);
  const attempts: Attempt[] = [{ tool, args: { ...args }, outcome: result.isError ? "error" : "ok" }];
  if (result.isError) return { tool, status: "unresolved", error: { message: resultText(result) }, attempts };
  return { tool, status: "ok", result: JSON.parse(resultText(result)) as Record<string, unknown>, attempts };
}

export type Policy = (call: CallTool, tool: string, args: Record<string, unknown>) => Promise<Outcome>;
export const POLICIES: Record<string, Policy> = { structured: callStructured, retry_all: callRetryAll, no_retry: callNoRetry };

export interface SubtaskResult {
  tool: string;
  status: string;
  result?: Record<string, unknown>;
  customerMessage?: string;
}

export interface SubtaskReport {
  status: "complete" | "partial" | "failed";
  results: SubtaskResult[];
  attempts: Attempt[];
  unresolved?: { tool: string; args: Record<string, unknown>; status: string; error?: Record<string, unknown> };
  not_attempted?: string[];
}

/** Run a subagent's tool steps. Recover locally; propagate only what it cannot resolve. */
export async function runSubtask(call: CallTool, steps: [string, Record<string, unknown>][], policy: Policy): Promise<SubtaskReport> {
  const report: SubtaskReport = { status: "complete", results: [], attempts: [] };
  for (let index = 0; index < steps.length; index++) {
    const [tool, args] = steps[index];
    const outcome = await policy(call, tool, args);
    report.attempts.push(...outcome.attempts);
    if (isResolved(outcome)) {
      const entry: SubtaskResult = { tool, status: outcome.status, result: outcome.result };
      if (outcome.customerMessage) entry.customerMessage = outcome.customerMessage;
      report.results.push(entry);
      continue;
    }
    // Could not resolve locally: tell the coordinator what worked, what failed, what was tried.
    report.status = report.results.length > 0 ? "partial" : "failed";
    report.unresolved = { tool, args, status: outcome.status, error: outcome.error };
    report.not_attempted = steps.slice(index + 1).map(([name]) => name);
    break;
  }
  return report;
}

/**
 * Repeats of an identical call whose previous attempt failed for a NON-transient reason.
 * Uses the backend's ground-truth log, so it is fair to both error styles.
 */
export function wastedRetries(log: LogEntry[]): number {
  let wasted = 0;
  for (let i = 1; i < log.length; i++) {
    const prev = log[i - 1];
    const cur = log[i];
    const sameCall = cur.tool === prev.tool && same(cur.args, prev.args);
    if (sameCall && prev.outcome !== "transient" && prev.outcome !== "ok") wasted++;
  }
  return wasted;
}
