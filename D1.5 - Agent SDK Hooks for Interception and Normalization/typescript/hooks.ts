/**
 * The two Agent SDK hooks this lab is about.
 *
 *   PostToolUse  matcher "^mcp__shop__get_"
 *       Rewrites every shop lookup result into ONE canonical shape (ISO 8601 UTC dates, a
 *       string status enum, dollars) via hookSpecificOutput.updatedToolOutput, BEFORE the
 *       model sees it. The model never has to guess what status 3 or 10/06/2026 means.
 *
 *   PreToolUse   matcher "mcp__shop__process_refund"
 *       Denies refunds above $500 with permissionDecision "deny" and a reason that tells the
 *       agent what to do instead (escalate_to_human). This is code, so it holds on every
 *       call; a sentence in the system prompt only holds most of the time.
 *
 * Hook callbacks are plain async functions, so they can be unit-tested by calling them with
 * the same input object the SDK would pass (see hookDemo.ts).
 */
import type { HookCallback, PostToolUseHookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { LegacyOrder, Shipment, V2Order } from "./shopServer.ts";

export const REFUND_LIMIT_USD = 500;

// The canonical status vocabulary every lookup is mapped onto. "unknown" is explicit so an
// unmapped backend value shows up as such instead of leaking through in its raw form.
export const STATUS_ENUM: readonly string[] = [
  "pending",
  "processing",
  "shipped",
  "in_transit",
  "delivered",
  "cancelled",
  "refunded",
  "unknown",
];
const LEGACY_STATUS_CODES: Record<number, string> = {
  0: "pending",
  1: "processing",
  2: "shipped",
  3: "delivered",
  4: "cancelled",
  5: "refunded",
};
const SHIPMENT_STATES: Record<string, string> = {
  "label created": "processing",
  "in transit": "in_transit",
  "out for delivery": "in_transit",
  delivered: "delivered",
  returned: "cancelled",
};

export interface HookEvent {
  hook: string;
  tool: string;
  action: string;
  input?: Record<string, unknown>;
}
/** Audit trail of hook decisions. Demos print it; the live run checks it. */
export const HOOK_EVENTS: HookEvent[] = [];

// ---------------------------------------------------------------------------
// Format converters (one per source format, all producing ISO 8601 UTC "...Z")
// ---------------------------------------------------------------------------

const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export const fromEpoch = (seconds: number) => isoZ(new Date(seconds * 1000));

export function fromIso(value: string): string {
  // No offset given: the v2 API contract says UTC (JS would otherwise assume local time).
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/i.test(value);
  return isoZ(new Date(hasOffset ? value : `${value}Z`));
}

export function fromUsDate(value: string): string {
  // The source is known to be MM/DD/YYYY, so 10/06/2026 is 6 October. Date-only values become
  // UTC midnight. Deciding this in code removes a guess the model would otherwise make.
  const [month, day, year] = value.split("/").map(Number);
  return isoZ(new Date(Date.UTC(year, month - 1, day)));
}

const status = (value: string) => (STATUS_ENUM.includes(value) ? value : "unknown");

export type CanonicalRecord = Record<string, string | number>;

function normalizeLegacyOrder(raw: unknown): CanonicalRecord {
  const r = raw as LegacyOrder;
  return {
    record_type: "order",
    order_id: r.ord_no,
    customer_id: r.cust,
    source_system: "legacy",
    status: LEGACY_STATUS_CODES[r.status] ?? "unknown",
    created_at: fromEpoch(r.created),
    updated_at: fromEpoch(r.last_update),
    total: r.total_cents / 100,
    currency: r.currency,
  };
}

function normalizeV2Order(raw: unknown): CanonicalRecord {
  const r = raw as V2Order;
  return {
    record_type: "order",
    order_id: r.orderId,
    customer_id: r.customerId,
    source_system: "v2",
    status: status(r.status.toLowerCase()),
    created_at: fromIso(r.createdAt),
    updated_at: fromIso(r.updatedAt),
    total: r.total.amount,
    currency: r.total.currency,
  };
}

function normalizeShipment(raw: unknown): CanonicalRecord {
  const r = raw as Shipment;
  return {
    record_type: "shipment",
    order_id: r.order,
    source_system: "carrier",
    status: SHIPMENT_STATES[r.state.toLowerCase()] ?? "unknown",
    shipped_at: fromUsDate(r.ship_date),
    estimated_delivery_at: fromUsDate(r.est_delivery),
    carrier: r.carrier,
    tracking_number: r.tracking_no,
  };
}

const NORMALIZERS: Record<string, (raw: unknown) => CanonicalRecord> = {
  get_order_legacy: normalizeLegacyOrder,
  get_order_v2: normalizeV2Order,
  get_shipment: normalizeShipment,
};

// ---------------------------------------------------------------------------
// tool_response plumbing
// ---------------------------------------------------------------------------

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Text of an MCP tool result. Accepts the shapes the CLI may hand a hook: a list of content
 * blocks, an object with "content", or a plain string. */
function payloadText(toolResponse: unknown): string | null {
  if (typeof toolResponse === "string") return toolResponse;
  const blocks: unknown = Array.isArray(toolResponse) ? toolResponse : isRecord(toolResponse) ? toolResponse.content : undefined;
  if (!Array.isArray(blocks)) return null;
  const texts = blocks.filter((b) => isRecord(b) && b.type === "text").map((b) => String((b as Record<string, unknown>).text ?? ""));
  return texts.length ? texts.join("") : null;
}

/** Return the replacement in the same shape the tool output arrived in. */
function wrapLike(original: unknown, text: string): unknown {
  const block = { type: "text", text };
  if (typeof original === "string") return text;
  if (isRecord(original)) return { ...original, content: [block] };
  return [block];
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

/** PostToolUse: replace a raw shop lookup with the canonical record. */
export const normalizeShopOutput: HookCallback = async (input) => {
  const i = input as PostToolUseHookInput;
  const short = i.tool_name.replace(/^mcp__shop__/, "");
  const normalizer = NORMALIZERS[short];
  const text = payloadText(i.tool_response);
  let payload: unknown = null;
  try {
    payload = text !== null ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!normalizer || !isRecord(payload) || "error" in payload) {
    return {}; // not a lookup we know, or an error result: pass it through untouched
  }

  const canonical = normalizer(payload);
  HOOK_EVENTS.push({ hook: "PostToolUse", tool: short, action: "normalized" });
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse" as const,
      updatedToolOutput: wrapLike(i.tool_response, JSON.stringify(canonical)),
    },
  };
};

function deny(reason: string, toolInput: Record<string, unknown>) {
  HOOK_EVENTS.push({ hook: "PreToolUse", tool: "process_refund", action: "deny", input: toolInput });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function parseAmount(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return NaN;
}

/** PreToolUse: block refunds above the limit and redirect to escalate_to_human. */
export const enforceRefundLimit: HookCallback = async (input) => {
  // The matcher scoped this hook to process_refund by NAME; the rule itself inspects the arguments.
  const i = input as PreToolUseHookInput;
  const toolInput: Record<string, unknown> = isRecord(i.tool_input) ? i.tool_input : {};
  const amount = parseAmount(toolInput.amount);

  if (!Number.isFinite(amount) || amount < 0) {
    // Fail closed: an amount we cannot read is never auto-approved.
    return deny(
      `process_refund needs a non-negative numeric amount, got ${JSON.stringify(toolInput.amount)}. ` +
        "Ask the customer to confirm the amount or call escalate_to_human.",
      toolInput,
    );
  }
  if (amount > REFUND_LIMIT_USD) {
    return deny(
      `Refund of $${amount.toFixed(2)} exceeds the $${REFUND_LIMIT_USD.toFixed(2)} limit for automatic refunds. ` +
        "This limit is enforced in code, so retrying process_refund will be denied again. " +
        "Call escalate_to_human with the order_id, the amount and a one-line summary so a human " +
        "agent can approve it, then tell the customer it has been escalated.",
      toolInput,
    );
  }

  HOOK_EVENTS.push({ hook: "PreToolUse", tool: "process_refund", action: "allow", input: toolInput });
  // {} = no opinion: the normal permission flow (allowedTools) decides, so the hook only ever
  // takes permissions away and never grants more than the configuration does.
  return {};
};

// Matchers match the tool NAME (Claude Code treats a pattern with regex characters as a regex).
export const HOOKS = {
  PreToolUse: [{ matcher: "mcp__shop__process_refund", hooks: [enforceRefundLimit] }],
  PostToolUse: [{ matcher: "^mcp__shop__get_", hooks: [normalizeShopOutput] }],
};
