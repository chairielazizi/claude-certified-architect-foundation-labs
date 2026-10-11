/**
 * D1.4 support backend: tools, data, the handoff contract, and the tool-execution layer.
 *
 * new ToolLayer(true) is the programmatic prerequisite gate (sample question 1). It sits in the
 * tool-execution layer, where every tool call passes through it, regardless of what the model decided:
 *   - lookup_order / lookup_invoice / process_refund are BLOCKED until get_customer has returned a
 *     verified customer_id in this session;
 *   - process_refund also needs that customer_id, the order/invoice looked up and owned by that
 *     customer, and an amount within the agent's refund limit.
 * Blocked calls return a structured is_error tool_result naming the missing prerequisite, so the
 * model can recover instead of failing.
 *
 * new ToolLayer(false) is prompt-only enforcement: the same tools, with the ordering rule living
 * only in the system prompt.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

export const SYSTEM_PROMPT =
  "You are a customer support agent for an electronics store. Always verify the customer's identity " +
  "with get_customer before looking up orders or invoices or processing refunds. Refunds above $500 " +
  "need a human agent: escalate with a complete handoff summary.";

export const AGENT_REFUND_LIMIT = 500;
const NEEDS_VERIFIED_CUSTOMER = new Set(["lookup_order", "lookup_invoice", "process_refund"]);

// Type aliases (not interfaces) so records stay assignable to Record<string, unknown>.
export type Customer = { customer_id: string; name: string; tier: string };
export type Order = { order_id: string; customer_id: string; item: string; total: number; status: string; delivered_on: string };
export type Charge = { charge_id: string; amount: number; date: string };
export type Invoice = { invoice_id: string; customer_id: string; description: string; charges: Charge[]; amount_due: number };
type LedgerRecord = Order | Invoice;

// Two customers share a name on purpose: a name typed in chat is not an identity.
// Key order matters for the legacy name lookup below, which takes the FIRST match.
export const CUSTOMERS: Record<string, Customer> = {
  "jordan.lee@example.net": { customer_id: "C-3090", name: "Jordan Lee", tier: "standard" },
  "jordan@example.com": { customer_id: "C-2001", name: "Jordan Lee", tier: "standard" },
  "sam@example.com": { customer_id: "C-2002", name: "Sam Rivera", tier: "gold" },
};
export const ORDERS: Record<string, Order> = {
  "ORD-1001": { order_id: "ORD-1001", customer_id: "C-2001", item: "Bluetooth speaker", total: 129.0, status: "delivered", delivered_on: "2026-10-03" },
  "ORD-2002": { order_id: "ORD-2002", customer_id: "C-2002", item: "65-inch OLED TV", total: 899.0, status: "delivered", delivered_on: "2026-10-04" },
};
export const INVOICES: Record<string, Invoice> = {
  "INV-77": {
    invoice_id: "INV-77",
    customer_id: "C-2001",
    description: "Premium membership, October",
    charges: [
      { charge_id: "CH-501", amount: 49.99, date: "2026-10-01" },
      { charge_id: "CH-502", amount: 49.99, date: "2026-10-01" },
    ],
    amount_due: 49.99,
  },
};

// ---------------------------------------------------------------------------
// Structured handoff: what a human agent needs when they cannot see the transcript
// ---------------------------------------------------------------------------

export type HandoffSummary = {
  customer_id: string; // the VERIFIED id, never a name
  issue_summary: string;
  root_cause: string;
  refund_amount: number;
  actions_taken: string[];
  recommended_action: string;
  priority: string; // low | normal | high | urgent
};

export const HANDOFF_FIELDS = ["customer_id", "issue_summary", "root_cause", "refund_amount", "actions_taken", "recommended_action", "priority"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const isSet = (v: unknown) => v !== undefined && v !== null;

/** Problems that would leave a human agent guessing (empty list = usable handoff). */
export function validateHandoff(summary: Record<string, unknown>): string[] {
  const problems = HANDOFF_FIELDS.filter((f) => isEmpty(summary[f])).map((f) => `${f}: missing`);
  const customerId = summary.customer_id;
  if (typeof customerId === "string" && customerId && !/^C-\d{4}$/.test(customerId)) {
    problems.push("customer_id: must be a verified id like C-1234, not a name");
  }
  const amount = summary.refund_amount;
  if (isSet(amount) && (typeof amount !== "number" || amount < 0)) problems.push("refund_amount: must be a non-negative number");
  const actions = summary.actions_taken;
  if (isSet(actions) && !(Array.isArray(actions) && actions.every((a) => typeof a === "string"))) {
    problems.push("actions_taken: must be a list of strings");
  }
  const priority = summary.priority;
  if (isSet(priority) && priority !== "" && !PRIORITIES.includes(String(priority))) {
    problems.push(`priority: must be one of ${JSON.stringify(PRIORITIES)}`);
  }
  return problems;
}

/** The ticket exactly as the human queue shows it: the summary is ALL the human gets. */
export function renderTicket(ticketId: string, summary: HandoffSummary): string {
  return [
    `[${ticketId}] priority=${summary.priority.toUpperCase()}  customer=${summary.customer_id}`,
    `Issue:       ${summary.issue_summary}`,
    `Root cause:  ${summary.root_cause}`,
    `Refund:      $${summary.refund_amount.toFixed(2)}`,
    "Actions taken:",
    ...summary.actions_taken.map((a) => `  - ${a}`),
    `Recommended: ${summary.recommended_action}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function schema(properties: Record<string, unknown>): Anthropic.Tool["input_schema"] {
  return { type: "object", properties, required: Object.keys(properties) };
}

const S = { type: "string" };
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_customer",
    description:
      "Verify a customer's identity by email. Returns the verified customer_id. Required before any " +
      "order, invoice or refund operation; a name typed in chat is not a verified identity.",
    input_schema: schema({ email: { type: "string", description: "Customer email, e.g. jordan@example.com" } }),
  },
  {
    name: "lookup_order",
    description: "Fetch one order (ORD-####): item, total, status, delivery date. Requires a verified customer.",
    input_schema: schema({ order_id: S }),
  },
  {
    name: "lookup_invoice",
    description:
      "Fetch one billing invoice (INV-##) with its individual charges. Use for billing disputes such as " +
      "double charges. Requires a verified customer.",
    input_schema: schema({ invoice_id: S }),
  },
  {
    name: "process_refund",
    description:
      "Refund against an order or invoice that you have looked up. customer_id must be the verified id. " +
      `Agents may refund up to $${AGENT_REFUND_LIMIT}; above that, use escalate_to_human.`,
    input_schema: schema({
      customer_id: S,
      reference_id: { type: "string", description: "ORD-#### or INV-##" },
      amount: { type: "number" },
      reason: S,
    }),
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the case to a human agent who CANNOT see this conversation. Provide a complete, self-contained " +
      "summary: verified customer_id, issue, root cause, refund amount, actions already taken, recommended " +
      "action and priority.",
    input_schema: schema({
      customer_id: S,
      issue_summary: S,
      root_cause: S,
      refund_amount: { type: "number" },
      actions_taken: { type: "array", items: S },
      recommended_action: S,
      priority: { type: "string", enum: PRIORITIES },
    }),
  },
];

/** Legacy CRM lookup used by the refund backend: accepts an id OR a name (first match wins). */
export function resolveCustomer(ref: unknown): string | null {
  const text = String(ref ?? "");
  for (const customer of Object.values(CUSTOMERS)) {
    if (text === customer.customer_id || text.toLowerCase() === customer.name.toLowerCase()) return customer.customer_id;
  }
  return null;
}

function refundable(record: LedgerRecord): number {
  if ("total" in record) return record.total;
  const billed = record.charges.reduce((sum, c) => sum + c.amount, 0);
  return Math.round((billed - record.amount_due) * 100) / 100;
}

export type CallRecord = { tool: string; input: Record<string, unknown>; outcome: "ok" | "error" | "blocked"; error?: string };
export type Refund = {
  refund_id: string;
  reference_id: string;
  amount: number;
  credited_customer_id: string | null;
  verified_at_time: boolean;
  status: string;
};
export type Escalation = { ticket_id: string; queue: string; status: string; summary: HandoffSummary };
type ToolError = { error: string; [key: string]: unknown };

/** Executes every tool call for the agent loop. enforce=true makes it the prerequisite gate. */
export class ToolLayer {
  verified: (Customer & { verified: boolean }) | null = null; // set ONLY by a successful get_customer
  lookedUp: Record<string, LedgerRecord> = {}; // reference_id -> record seen this session
  calls: CallRecord[] = []; // audit log of every call and its outcome
  refunds: Refund[] = [];
  escalations: Escalation[] = [];

  constructor(readonly enforce = true) {}

  /** Run a tool; returns [jsonContent, isError]. */
  execute(name: string, args: Record<string, unknown>): [string, boolean] {
    const blocked = (this.enforce ? this.checkPrerequisites(name, args) : null) ?? this.checkHandoff(name, args);
    if (blocked) {
      this.calls.push({ tool: name, input: args, outcome: "blocked", error: blocked.error });
      return [JSON.stringify(blocked), true];
    }
    const [result, isError] = this.run(name, args);
    this.calls.push({ tool: name, input: args, outcome: isError ? "error" : "ok" });
    return [JSON.stringify(result), isError];
  }

  /** The gate. Returns a structured error naming what is missing, or null to allow. */
  checkPrerequisites(name: string, args: Record<string, unknown>): ToolError | null {
    if (NEEDS_VERIFIED_CUSTOMER.has(name) && this.verified === null) {
      return {
        error: "prerequisite_not_met", blocked_tool: name, missing_prerequisite: "get_customer",
        detail: "No verified customer in this session. Call get_customer with the customer's email first; " +
          "a name typed in chat is not an identity.",
      };
    }
    if (name !== "process_refund" || this.verified === null) return null;
    const verifiedId = this.verified.customer_id;
    if (args.customer_id !== verifiedId) {
      return {
        error: "prerequisite_not_met", blocked_tool: name, missing_prerequisite: "verified customer_id",
        detail: `customer_id ${JSON.stringify(args.customer_id)} is not the verified customer ${verifiedId}.`,
      };
    }
    const ref = String(args.reference_id ?? "");
    const record = this.lookedUp[ref];
    if (record === undefined) {
      const lookup = ref.startsWith("INV-") ? "lookup_invoice" : "lookup_order";
      return { error: "prerequisite_not_met", blocked_tool: name, missing_prerequisite: lookup, detail: `Look up ${ref} before refunding against it.` };
    }
    if (record.customer_id !== verifiedId) {
      return { error: "ownership_mismatch", blocked_tool: name, detail: `${ref} does not belong to verified customer ${verifiedId}.` };
    }
    const amount = Number(args.amount ?? 0);
    if (amount > refundable(record)) {
      return { error: "amount_exceeds_charge", blocked_tool: name, refundable: refundable(record), requested: amount };
    }
    if (amount > AGENT_REFUND_LIMIT) {
      return {
        error: "refund_limit_exceeded", blocked_tool: name, limit: AGENT_REFUND_LIMIT, requested: amount,
        required_next_step: "escalate_to_human with a complete handoff summary",
      };
    }
    return null;
  }

  /** Handoff validation is data validation, so it applies in both modes. */
  checkHandoff(name: string, args: Record<string, unknown>): ToolError | null {
    if (name !== "escalate_to_human") return null;
    const problems = validateHandoff(args);
    const given = args.customer_id;
    if (this.verified && isSet(given) && given !== "" && given !== this.verified.customer_id) {
      problems.push("customer_id: does not match the verified customer");
    }
    if (problems.length === 0) return null;
    return {
      error: "invalid_handoff", blocked_tool: name, problems,
      detail: "The human agent cannot see this conversation; the summary must stand on its own.",
    };
  }

  private run(name: string, args: Record<string, unknown>): [Record<string, unknown>, boolean] {
    if (name === "get_customer") {
      const customer = CUSTOMERS[String(args.email ?? "").toLowerCase()];
      if (!customer) return [{ error: "not_found", detail: "No customer with that email" }, true];
      const verified = { ...customer, verified: true };
      this.verified = verified;
      return [verified, false];
    }
    if (name === "lookup_order") {
      const order = ORDERS[String(args.order_id ?? "").toUpperCase()];
      if (!order) return [{ error: "not_found", detail: `No record ${JSON.stringify(args.order_id)}` }, true];
      this.lookedUp[order.order_id] = order;
      return [order, false];
    }
    if (name === "lookup_invoice") {
      const invoice = INVOICES[String(args.invoice_id ?? "").toUpperCase()];
      if (!invoice) return [{ error: "not_found", detail: `No record ${JSON.stringify(args.invoice_id)}` }, true];
      this.lookedUp[invoice.invoice_id] = invoice;
      return [invoice, false];
    }
    if (name === "process_refund") {
      const refund: Refund = {
        refund_id: `RF-${String(this.refunds.length + 1).padStart(3, "0")}`,
        reference_id: String(args.reference_id ?? ""),
        amount: Number(args.amount ?? 0),
        credited_customer_id: resolveCustomer(args.customer_id),
        verified_at_time: this.verified !== null,
        status: "processed",
      };
      this.refunds.push(refund);
      return [refund, false];
    }
    if (name === "escalate_to_human") {
      const ticket = { ticket_id: `HD-${4400 + this.escalations.length + 1}`, queue: "tier2-refunds", status: "queued" };
      this.escalations.push({ ...ticket, summary: args as unknown as HandoffSummary });
      return [ticket, false];
    }
    return [{ error: `unknown tool ${name}` }, true];
  }
}

export function ownerOf(referenceId: string): string | null {
  const record: LedgerRecord | undefined = ORDERS[referenceId] ?? INVOICES[referenceId];
  return record ? record.customer_id : null;
}

// ---------------------------------------------------------------------------
// The agent loop (same shape as D1.1) and helpers for scripted models
// ---------------------------------------------------------------------------

const SAFETY_MAX_ITERATIONS = 15;

export async function runAgent(
  client: lab.MessagesClient,
  request: string,
  tools: ToolLayer,
  verbose = true,
): Promise<{ answer: string; messages: Anthropic.MessageParam[] }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: request }];
  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system: SYSTEM_PROMPT, tools: TOOLS, messages });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return { answer: lab.textOf(response), messages };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of lab.toolUses(response)) {
      const [content, isError] = tools.execute(block.name, block.input as Record<string, unknown>);
      if (verbose) {
        const shown = isError ? `is_error ${content}` : content.slice(0, 220); // errors in full: they drive recovery
        console.log(`  ${block.name}(${JSON.stringify(block.input)})\n     -> ${shown}`);
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error(`Agent did not finish in ${SAFETY_MAX_ITERATIONS} iterations`);
}

export type LogEntry = { name: string; input: Record<string, unknown>; result: Record<string, unknown>; isError: boolean };

/** Every tool call so far with its parsed result, in order (for model-driven scripted turns). */
export function toolLog(params: lab.CreateParams): LogEntry[] {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const log: LogEntry[] = [];
  for (const msg of params.messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        calls.set(block.id, { name: block.name, input: block.input as Record<string, unknown> });
      } else if (block.type === "tool_result") {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const result = JSON.parse(lab.toolResultText(block)) as Record<string, unknown>;
        log.push({ name: call.name, input: call.input, result, isError: Boolean(block.is_error) });
      }
    }
  }
  return log;
}

export function tag(text: string, name: string): string {
  const match = text.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`));
  return match ? match[1] : "";
}

function mustMatch(text: string, re: RegExp, group = 0): string {
  const match = text.match(re);
  if (!match) throw new Error(`scripted model: ${re} not found in request`);
  return match[group];
}

/**
 * Offline stand-in for Claude on refund requests; decides each turn from the conversation.
 * skipVerification=true reproduces sample question 1's failure mode: despite the system prompt,
 * the model acts on the name the customer typed instead of calling get_customer first.
 */
export function makeSupportModel(skipVerification = false): lab.Responder {
  return (params: lab.CreateParams): Anthropic.Message => {
    const first = params.messages[0].content;
    const request = typeof first === "string" ? first : "";
    const email = mustMatch(request, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    const statedName = mustMatch(request, /I'm ([A-Z][a-z]+ [A-Z][a-z]+)/, 1);
    const orderId = mustMatch(request, /ORD-\d+/);
    const statedAmount = Number(mustMatch(request, /\$([\d,]+\.\d{2})/, 1).replaceAll(",", ""));
    const log = toolLog(params);
    const last = log.length ? log[log.length - 1] : null;
    const succeeded = (tool: string): Record<string, unknown> | null => log.find((e) => e.name === tool && !e.isError)?.result ?? null;

    const customer = succeeded("get_customer") as Customer | null;
    const order = succeeded("lookup_order") as Order | null;
    const refund = succeeded("process_refund") as Refund | null;
    const ticket = succeeded("escalate_to_human") as { ticket_id: string } | null;

    if (ticket && order) {
      return lab.message([lab.text(
        `I'm sorry about the ${order.item}. A refund of $${order.total.toFixed(2)} needs approval from a senior ` +
          `agent, so I've escalated it as ticket ${ticket.ticket_id} with everything they need. You won't ` +
          "have to repeat any of this.",
      )]);
    }
    if (refund) {
      return lab.message([lab.text(`Done: I've refunded $${refund.amount.toFixed(2)} for order ${refund.reference_id} (refund ${refund.refund_id}).`)]);
    }
    if (last && last.isError && last.result.missing_prerequisite === "get_customer") {
      return lab.message([lab.text("I need to verify your account first."), lab.toolUse("get_customer", { email })]);
    }
    if (skipVerification && log.length === 0) {
      // The failure mode: acts on the name typed in chat instead of verifying identity.
      return lab.message([
        lab.text("I'll get that refund started right away."),
        lab.toolUse("process_refund", { customer_id: statedName, reference_id: orderId, amount: statedAmount, reason: "Item arrived damaged" }),
      ]);
    }
    if (!customer) return lab.message([lab.text("Let me verify your account first."), lab.toolUse("get_customer", { email })]);
    if (!order) return lab.message([lab.toolUse("lookup_order", { order_id: orderId })]);
    if (last && last.isError && last.result.error === "refund_limit_exceeded") {
      const damage = request.includes("cracked screen") ? "cracked screen" : "damage on arrival";
      const total = order.total.toFixed(2);
      const limit = AGENT_REFUND_LIMIT.toFixed(0);
      const handoff: HandoffSummary = {
        customer_id: customer.customer_id,
        issue_summary: `${order.item} from order ${orderId} arrived damaged; the customer wants a full refund.`,
        root_cause: `Damaged in transit (customer reports a ${damage}). The $${total} refund is above the $${limit} agent limit, so it needs human approval.`,
        refund_amount: order.total,
        actions_taken: [
          `Verified identity with get_customer (${customer.customer_id}, ${customer.tier} tier)`,
          `Looked up ${orderId}: ${order.item}, $${total}, ${order.status} ${order.delivered_on}`,
          `Attempted a $${total} refund: blocked by the $${limit} agent refund limit`,
        ],
        recommended_action: `Approve a full refund of $${total} to the original payment method and arrange carrier pickup of the damaged unit.`,
        priority: customer.tier === "gold" ? "high" : "normal",
      };
      return lab.message([
        lab.text("This refund needs a senior agent's approval; I'll hand it over."),
        lab.toolUse("escalate_to_human", handoff),
      ]);
    }
    return lab.message([
      lab.toolUse("process_refund", { customer_id: customer.customer_id, reference_id: orderId, amount: order.total, reason: "Item arrived damaged" }),
    ]);
  };
}
