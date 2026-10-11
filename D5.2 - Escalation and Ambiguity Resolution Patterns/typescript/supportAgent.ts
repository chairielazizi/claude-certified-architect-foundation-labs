/**
 * Support agent shared by the D5.2 demos: prompts, tools, backend, agent loop, scripted models.
 *
 * Two system prompts are compared:
 *  - BASELINE_PROMPT: "escalate complex cases". No decision boundary, so the agent guesses.
 *  - CRITERIA_PROMPT: explicit escalation criteria plus few-shot examples (sample question 3's fix).
 *
 * Offline, one scripted model stands in for Claude and behaves according to whichever prompt it
 * receives. With the baseline prompt it reproduces the miscalibration from sample question 3's
 * logs: it escalates standard damage replacements and improvises policy exceptions. With the
 * criteria prompt it follows the written criteria. Both profiles decide from the conversation
 * (what the customer said, which tools ran, what they returned); nothing is keyed to a case id.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import * as lab from "../../shared/typescript/labkit.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf-8"));
}

interface Order {
  order_id: string;
  item: string;
  total: string;
  status: string;
  delivered_on?: string;
  current_site_price?: string;
  refund_status?: string;
  refund_issued_on?: string;
}
interface LatestOrder {
  order_id: string;
  item: string;
  status: string;
  date: string;
}
interface Customer {
  customer_id: string;
  name: string;
  email: string;
  city: string;
  postal_code: string;
  latest_order: LatestOrder;
}
interface Match {
  customer_id: string;
  name: string;
  city: string;
  last_order_date?: string;
}
/** Loose view of any tool result the scripted model reads. */
interface ToolData extends Partial<Order> {
  matches?: Match[];
  ticket?: string;
  replacement_id?: string;
  ships_within_days?: number;
  refunded?: string;
  amount?: string;
}

/** One labelled test case from fixtures/cases.json. */
export interface Case {
  id: string;
  message: string;
  expected: string;
  reason: string | null;
  sentiment: number;
  self_confidence: number;
}

const BACKEND = loadFixture("backend.json") as { orders: Record<string, Order>; customers: Customer[] };

export const BASELINE_PROMPT =
  "You are a customer support agent for an electronics store. Use the tools to help customers. " +
  "Escalate complex cases to a human agent.";

export const CRITERIA_PROMPT = `You are a customer support agent for an electronics store. Use the tools to help customers.

POLICY
- Damaged on arrival: free replacement when the customer provides photo evidence. No photo yet: ask for one.
- Price adjustment: if OUR site's price drops within 14 days of purchase, refund the difference with apply_price_adjustment.
- Refunds: within 30 days of delivery.
- The policy does NOT cover competitor price matching, bulk or business discounts, or exceptions to the windows above.

ESCALATION CRITERIA (call escalate_to_human with the matching reason_category)
1. explicit_request: the customer explicitly asks for a human, a person or a manager. Escalate immediately.
   Do not look anything up or try to resolve first.
2. policy_gap / policy_exception: the request is something the policy does not cover, or asks for an
   exception to it. Do not improvise a policy.
3. no_progress: you cannot make meaningful progress with your tools (for example, a refund was issued
   but has not arrived and you have no way to trace it).
Do NOT escalate because a case seems complex, emotional or expensive. Straightforward cases the policy
covers are yours to resolve even when the customer is upset: acknowledge the frustration, then resolve.
If the customer only hints that they might want a person, acknowledge it, offer the resolution, and
escalate if they repeat the request.
If a customer lookup returns more than one match, ask for an additional identifier (email or postal
code). Never pick one of the matches by heuristic.

EXAMPLES
Customer: "I want to talk to a real person about my order ORD-1234."
-> escalate_to_human(reason_category="explicit_request") immediately. Do not call lookup_order first.
Customer: "My toaster ORD-2222 arrived with a cracked lid, photo attached."
-> lookup_order, then issue_replacement. Do not escalate: the policy covers it.
Customer: "CompetitorMart sells this for $30 less, can you match it? ORD-3333"
-> lookup_order, then escalate_to_human(reason_category="policy_gap"). The policy covers our own price drops only.
Customer: "THIS IS THE SECOND BROKEN KETTLE!!! ORD-4444, photo attached."
-> Acknowledge the frustration, lookup_order, issue_replacement. Frustration alone is not a trigger.
Customer: "Can you refund ORD-5555? I know it's three months old."
-> lookup_order, then escalate_to_human(reason_category="policy_exception").
`;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "lookup_order",
    description: "Fetch one order by ID (format ORD-####): item, total, status, dates, refund status and our current site price.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "lookup_customer",
    description:
      "Find customer accounts by name, email or postal code. Returns a list of matches; a name can " +
      "match several accounts. Full account details are only returned for a unique match.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string" }, postal_code: { type: "string" } },
    },
  },
  {
    name: "issue_replacement",
    description: "Ship a free replacement for a damaged item. Policy: only with photo evidence of the damage.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" }, reason: { type: "string" } },
      required: ["order_id", "reason"],
    },
  },
  {
    name: "apply_price_adjustment",
    description: "Refund the difference when our own site's price dropped within 14 days of purchase. Amount like '20.00'.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" }, amount: { type: "string" } },
      required: ["order_id", "amount"],
    },
  },
  {
    name: "issue_refund",
    description: "Refund an order. Policy: within 30 days of delivery. Amount like '59.00'.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" }, amount: { type: "string" } },
      required: ["order_id", "amount"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the case to a human agent with a structured summary so the customer never has to repeat " +
      "themselves. reason_category says which escalation criterion applies.",
    input_schema: {
      type: "object",
      properties: {
        reason_category: { type: "string", enum: ["explicit_request", "policy_gap", "policy_exception", "no_progress", "other"] },
        summary: { type: "string" },
        order_id: { type: "string" },
      },
      required: ["reason_category", "summary"],
    },
  },
];

const RESOLUTION_TOOLS = ["issue_replacement", "apply_price_adjustment", "issue_refund"];

/** Simulated backend. Returns [jsonContent, isError]. */
export function executeTool(name: string, args: Record<string, string | undefined>): [string, boolean] {
  if (name === "lookup_order") {
    const order = BACKEND.orders[args.order_id ?? ""];
    return order ? [JSON.stringify(order), false] : [JSON.stringify({ error: "order not found" }), true];
  }
  if (name === "lookup_customer") {
    const people = BACKEND.customers;
    let found: Customer[];
    if (args.email) found = people.filter((c) => c.email === String(args.email).toLowerCase());
    else if (args.postal_code) found = people.filter((c) => c.postal_code === args.postal_code);
    else found = people.filter((c) => c.name.toLowerCase() === String(args.name ?? "").toLowerCase());
    if (found.length > 1) {
      // several accounts: return only what is needed to disambiguate
      const summaries: Match[] = found.map((c) => ({ customer_id: c.customer_id, name: c.name, city: c.city, last_order_date: c.latest_order.date }));
      return [JSON.stringify({ matches: summaries }), false];
    }
    return [JSON.stringify({ matches: found }), false];
  }
  const orderId = args.order_id ?? "";
  if (name === "issue_replacement") {
    return [JSON.stringify({ status: "replacement_created", replacement_id: "RPL-" + orderId.slice(-4), ships_within_days: 2 }), false];
  }
  if (name === "apply_price_adjustment") return [JSON.stringify({ status: "adjusted", order_id: orderId, refunded: args.amount }), false];
  if (name === "issue_refund") return [JSON.stringify({ status: "refunded", order_id: orderId, amount: args.amount }), false];
  if (name === "escalate_to_human") {
    const suffix = (args.order_id || "GEN-0001").slice(-4);
    return [JSON.stringify({ ticket: `ESC-${suffix}`, queue: "tier2", reason_category: args.reason_category }), false];
  }
  return [JSON.stringify({ error: `unknown tool ${name}` }), true];
}

/** n/d as a percentage with one decimal, rounded half-up in integer math (identical in Python). */
export function pct(n: number, d: number): string {
  const tenths = Math.floor((n * 2000 + d) / (2 * d));
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** Outcome of a conversation, read from the actions taken (not from the wording). */
export function classify(calls: string[]): string {
  if (calls.includes("escalate_to_human")) return "escalate";
  if (calls.some((c) => RESOLUTION_TOOLS.includes(c))) return "resolve";
  return "reply"; // no action taken: the agent answered or asked for something
}

const SAFETY_MAX_ITERATIONS = 10;

export interface ConversationResult {
  turnCalls: string[][];
  calls: string[];
  replies: string[];
  outcome: string;
}

/** Agentic loop over one or more customer turns (full history every request). */
export async function runConversation(
  client: lab.MessagesClient,
  system: string,
  userTurns: string[],
  verbose = true,
): Promise<ConversationResult> {
  const messages: Anthropic.MessageParam[] = [];
  const turnCalls: string[][] = [];
  const replies: string[] = [];
  for (const text of userTurns) {
    messages.push({ role: "user", content: text });
    const calls: string[] = [];
    let reply: string | null = null;
    for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
      // runaway guard only; stop_reason ends the turn
      const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system, tools: TOOLS, messages: [...messages] });
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") {
        reply = lab.textOf(response);
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of lab.toolUses(response)) {
        calls.push(block.name);
        const input = block.input as Record<string, string | undefined>;
        const [content, isError] = executeTool(block.name, input);
        if (verbose) console.log(`    -> ${block.name}(${JSON.stringify(input)})`);
        results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    if (reply === null) throw new Error("agent loop did not converge");
    turnCalls.push(calls);
    replies.push(reply);
  }
  const everyCall = turnCalls.flat();
  return { turnCalls, calls: everyCall, replies, outcome: classify(everyCall) };
}

// ---------------------------------------------------------------------------
// Conversation signals and state (what the scripted model "reads")
// ---------------------------------------------------------------------------

const HUMAN_RE = /\b(?:a human|a person|a manager|real person|human agent)\b/;
const HEDGE_RE = /\b(?:maybe|might|perhaps|should i)\b/;
const DAMAGE_RE = /\b(?:cracked|broken|dented|chipped|damaged|shattered)\b/;
const PHOTO_RE = /\b(?:photo|picture)\b/;
const COMPETITOR_RE = /\bprice-match\b|\bprice match\b|\bmatch (?:their|the|that) price\b|\bcompetitor\b/;
const OWN_DROP_RE = /\bprice\b.*\bdropped\b|\bdropped the price\b/;
const EXCEPTION_RE = /\bmake an exception\b|\bpast the \d+-day window\b|\boutside the (?:return )?window\b/;
const REFUND_MISSING_RE = /\brefund\b.*\b(?:hasn't|has not|never|not yet)\b.*\b(?:arrived|reached|come)\b/;
const BULK_RE = /\b(?:bulk|business|volume) discount\b/;
const FRUSTRATED_RE = /!!|\b(?:unbelievable|ridiculous|seriously|fed up|fix this|again)\b/;
const ACCEPT_RE = /\b(?:yes|ok|okay|fine|go ahead|please do|send it)\b/;
const ORDER_RE = /ORD-\d{4}/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const NAME_RE = /\b(?:I'm|I am|my name is) ([A-Z][a-z]+ [A-Z][a-z]+)/;
const OFFER_MARKER = "Shall I go ahead?";

interface Signals {
  damage: boolean;
  photo: boolean;
  competitor: boolean;
  own_site_drop: boolean;
  exception: boolean;
  refund_missing: boolean;
  bulk: boolean;
  frustrated: boolean;
}

export function signals(text: string): Signals {
  const t = text.toLowerCase();
  return {
    damage: DAMAGE_RE.test(t),
    photo: PHOTO_RE.test(t),
    competitor: COMPETITOR_RE.test(t),
    own_site_drop: OWN_DROP_RE.test(t),
    exception: EXCEPTION_RE.test(t),
    refund_missing: REFUND_MISSING_RE.test(t),
    bulk: BULK_RE.test(t),
    frustrated: FRUSTRATED_RE.test(t),
  };
}

type HasMessages = { messages: Anthropic.MessageParam[] };

/** What the customer has typed so far (tool-result messages excluded). */
export function userTexts(params: HasMessages): string[] {
  const out: string[] = [];
  for (const m of params.messages) if (m.role === "user" && typeof m.content === "string") out.push(m.content);
  return out;
}

function assistantTexts(params: HasMessages): string[] {
  const out: string[] = [];
  for (const m of params.messages) {
    if (m.role === "assistant" && typeof m.content !== "string") out.push(m.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
  }
  return out;
}

export interface ConversationState {
  human_mentions: number;
  explicit_now: boolean;
  resolution_offered: boolean;
  frustrated: boolean;
}

/** State derived from the full history on every turn (the API itself remembers nothing). */
export function conversationState(params: HasMessages): ConversationState {
  const texts = userTexts(params);
  const latest = texts.length ? texts[texts.length - 1].toLowerCase() : "";
  return {
    human_mentions: texts.filter((t) => HUMAN_RE.test(t.toLowerCase())).length,
    explicit_now: HUMAN_RE.test(latest) && !HEDGE_RE.test(latest),
    resolution_offered: assistantTexts(params).some((t) => t.includes(OFFER_MARKER)),
    frustrated: texts.some((t) => FRUSTRATED_RE.test(t.toLowerCase())),
  };
}

const cents = (amount: string) => parseInt(amount.replace(".", ""), 10);
const money = (value: number) => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;

function escalate(ack: string, category: string, summary: string, orderId: string | null): Anthropic.Message {
  const args: Record<string, string> = { reason_category: category, summary };
  if (orderId) args.order_id = orderId;
  return lab.message([lab.text(ack + "I am bringing in a colleague who can help with this."), lab.toolUse("escalate_to_human", args)]);
}

function afterAction(name: string, data: ToolData, ack: string): Anthropic.Message {
  if (name === "escalate_to_human") {
    return lab.message([lab.text(`${ack}A human colleague has your case (ticket ${data.ticket}) with a full summary, so you will not need to repeat anything.`)]);
  }
  if (name === "issue_replacement") {
    return lab.message([lab.text(`${ack}Your replacement (${data.replacement_id}) ships within ${data.ships_within_days} days.`)]);
  }
  if (name === "apply_price_adjustment") return lab.message([lab.text(`Done: $${data.refunded} is on its way back to your card for ${data.order_id}.`)]);
  return lab.message([lab.text(`Done: $${data.amount} has been refunded for ${data.order_id}.`)]);
}

function customerReply(data: ToolData, pickByHeuristic: boolean): Anthropic.Message {
  const matches = data.matches ?? [];
  if (matches.length > 1 && !pickByHeuristic) {
    return lab.message([
      lab.text(
        `I found ${matches.length} accounts under that name. So I open the right one, could you confirm ` +
          "the email address or postal code on your account?",
      ),
    ]);
  }
  if (!matches.length) return lab.message([lab.text("I could not find an account with those details. Could you double-check them?")]);
  // BAD when there are several: "most recent activity is probably them"
  const chosen = matches.length > 1 ? matches.reduce((a, b) => ((b.last_order_date ?? "") > (a.last_order_date ?? "") ? b : a)) : matches[0];
  const full = BACKEND.customers.find((c) => c.customer_id === chosen.customer_id);
  if (!full) throw new Error("unknown customer");
  const order = full.latest_order;
  return lab.message([lab.text(`Thanks! Your latest order ${order.order_id} (${order.item}) is ${order.status} (${full.city} account).`)]);
}

function lastResult(params: lab.CreateParams): ToolData | null {
  const results = lab.toolResults(params);
  return results.length ? (JSON.parse(lab.toolResultText(results[results.length - 1])) as ToolData) : null;
}

// ---------------------------------------------------------------------------
// Profile 1: explicit criteria + few-shot examples
// ---------------------------------------------------------------------------

function criteriaAgent(params: lab.CreateParams): Anthropic.Message {
  const texts = userTexts(params);
  const latest = texts[texts.length - 1];
  const conversation = texts.join(" ");
  const sig = signals(conversation);
  const state = conversationState(params);
  const called = lab.allToolCalls(params);
  const data = lastResult(params);
  // Acknowledge frustration in the turn where it is expressed; it is not an escalation trigger.
  const ack = FRUSTRATED_RE.test(latest.toLowerCase()) ? "I am sorry about this, I can see how frustrating it is. " : "";
  const orderMatch = conversation.match(ORDER_RE);
  const orderId = orderMatch ? orderMatch[0] : null;

  if (data) {
    // react to the tool that just ran
    const last = called[called.length - 1];
    if (last === "lookup_customer") return customerReply(data, false);
    if (last !== "lookup_order") return afterAction(last, data, ack);
    const item = data.item ?? "item";
    if (sig.competitor || sig.bulk) {
      return escalate(ack, "policy_gap", `Customer asks for a competitor price match on ${orderId}; policy covers only our own price drops.`, orderId);
    }
    if (sig.exception) {
      return escalate(ack, "policy_exception", `Refund requested for ${orderId} outside the 30-day window (delivered ${data.delivered_on}).`, orderId);
    }
    if (sig.refund_missing && data.refund_status === "issued") {
      return escalate(ack, "no_progress", `Refund for ${orderId} issued ${data.refund_issued_on} but not received; agent cannot trace bank transfers.`, orderId);
    }
    if (sig.damage && !sig.photo) {
      return lab.message([lab.text(`${ack}I am sorry the ${item} arrived damaged. Could you send a photo of the damage? Then I can ship a free replacement straight away.`)]);
    }
    if (sig.damage && state.human_mentions === 1 && !state.resolution_offered) {
      // A hint, not a demand: offer the resolution first and keep the door open.
      return lab.message([
        lab.text(`${ack}I can ship a free replacement ${item} today. ${OFFER_MARKER} If you would still prefer to speak with a person, just tell me.`),
      ]);
    }
    if (sig.damage) {
      return lab.message([
        lab.text(ack + "That is covered, so I will sort it now."),
        lab.toolUse("issue_replacement", { order_id: orderId, reason: "damaged on arrival, photo provided" }),
      ]);
    }
    if (sig.own_site_drop && data.current_site_price) {
      const diff = money(cents(data.total ?? "0.00") - cents(data.current_site_price));
      return lab.message([
        lab.text(ack + "Our price did drop within 14 days, so you are owed the difference."),
        lab.toolUse("apply_price_adjustment", { order_id: orderId, amount: diff }),
      ]);
    }
    return lab.message([lab.text(`Your order ${orderId} (${item}) is ${(data.status ?? "").replaceAll("_", " ")}.`)]);
  }

  // A new customer message. Explicit requests (or a repeated hint) win before anything else.
  if (state.explicit_now || state.human_mentions >= 2) return escalate(ack, "explicit_request", `Customer asked for a human. Context: ${latest}`, orderId);
  if (state.resolution_offered && ACCEPT_RE.test(latest.toLowerCase()) && orderId) {
    return lab.message([lab.toolUse("issue_replacement", { order_id: orderId, reason: "damaged on arrival, photo provided" })]);
  }
  if (sig.bulk) return escalate(ack, "policy_gap", "Customer asks for a bulk business discount; policy does not cover discounts.", null);
  if (orderId && !called.includes("lookup_order")) {
    return lab.message([lab.text(ack + "Let me check that order."), lab.toolUse("lookup_order", { order_id: orderId })]);
  }
  const email = latest.match(EMAIL_RE);
  if (email) return lab.message([lab.toolUse("lookup_customer", { email: email[0] })]);
  const name = conversation.match(NAME_RE);
  if (name && !called.includes("lookup_customer")) return lab.message([lab.toolUse("lookup_customer", { name: name[1] })]);
  return lab.message([lab.text("Could you share your order number so I can help?")]);
}

// ---------------------------------------------------------------------------
// Profile 2: vague prompt ("escalate complex cases") - the sample question 3 logs
// ---------------------------------------------------------------------------

function baselineAgent(params: lab.CreateParams): Anthropic.Message {
  const conversation = userTexts(params).join(" ");
  const sig = signals(conversation);
  const called = lab.allToolCalls(params);
  const data = lastResult(params);
  const orderMatch = conversation.match(ORDER_RE);
  const orderId = orderMatch ? orderMatch[0] : null;

  if (data) {
    const last = called[called.length - 1];
    if (last === "lookup_customer") return customerReply(data, true);
    if (last !== "lookup_order") return afterAction(last, data, "");
    if (HUMAN_RE.test(conversation.toLowerCase())) return escalate("", "explicit_request", "Customer wants a human.", orderId); // only after investigating
    if (sig.damage && sig.photo) return escalate("", "other", "Damaged item, seems complex.", orderId); // escalates a covered case
    if (sig.damage) return lab.message([lab.text("Sorry about that! Could you send a photo of the damage?")]);
    if (sig.competitor) {
      // improvises a policy that does not exist
      const stated = conversation.match(/\$(\d+) less/);
      const amount = stated ? money(parseInt(stated[1], 10) * 100) : money(Math.floor(cents(data.total ?? "0.00") / 10));
      return lab.message([lab.toolUse("apply_price_adjustment", { order_id: orderId, amount })]);
    }
    if (sig.exception) return lab.message([lab.toolUse("issue_refund", { order_id: orderId, amount: data.total })]); // grants an unapproved exception
    if (sig.refund_missing) return escalate("", "no_progress", "Customer has not received refund.", orderId);
    if (sig.own_site_drop && data.current_site_price) {
      const diff = money(cents(data.total ?? "0.00") - cents(data.current_site_price));
      return lab.message([lab.toolUse("apply_price_adjustment", { order_id: orderId, amount: diff })]);
    }
    return lab.message([lab.text(`Your order ${orderId} is ${(data.status ?? "").replaceAll("_", " ")}.`)]);
  }

  if (orderId && !called.includes("lookup_order")) {
    return lab.message([lab.text("Let me look into that."), lab.toolUse("lookup_order", { order_id: orderId })]); // always investigates first
  }
  if (sig.bulk) return lab.message([lab.text("Great news: I can offer your studio 15% off all future orders with code STUDIO15.")]);
  const name = conversation.match(NAME_RE);
  if (name && !called.includes("lookup_customer")) return lab.message([lab.toolUse("lookup_customer", { name: name[1] })]);
  return lab.message([lab.text("How can I help?")]);
}

/** The same stand-in model; its behaviour depends on the system prompt it was given. */
export function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  return lab.systemText(params).includes("ESCALATION CRITERIA") ? criteriaAgent(params) : baselineAgent(params);
}
