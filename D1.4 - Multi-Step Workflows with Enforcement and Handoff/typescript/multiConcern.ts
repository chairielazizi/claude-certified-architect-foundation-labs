/**
 * D1.4 - Multi-concern requests: decompose, investigate in parallel with shared context, unify.
 *
 *   "ORD-1001 arrived damaged AND I was double-charged on invoice INV-77"
 *     1. decompose    -> two distinct concerns, each with its own reference
 *     2. verify ONCE  -> get_customer through the gate; the verified facts become shared context
 *     3. investigate  -> one investigator per concern, run concurrently (Promise.all), each given
 *                        the shared verified-customer context instead of re-verifying
 *     4. act          -> proposed refunds go through the same gated tool layer
 *     5. synthesise   -> ONE reply that resolves both items
 *
 * Run:  npx tsx multiConcern.ts          (offline, 300 ms simulated latency per model call)
 *       npx tsx multiConcern.ts --live   (real API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { TOOLS, ToolLayer, tag, type Customer, type Invoice, type Order } from "./supportTools.ts";

const REQUEST = "Hi, it's jordan@example.com. ORD-1001 arrived damaged AND I was double-charged on invoice INV-77.";
const LATENCY_MS = 300;
const SAFETY_MAX_ITERATIONS = 8;

const DECOMPOSER_PROMPT =
  "ROLE: request decomposer\n" +
  "Split the customer's message into distinct concerns, one per issue, each with the order or invoice it " +
  "refers to and the customer's own words. Also extract the customer's email. Return JSON.";
const INVESTIGATOR_PROMPT =
  "ROLE: concern investigator\n" +
  "Investigate ONE concern for a customer whose identity is already verified (see <verified_customer>); do " +
  "not re-verify. Use lookup_order or lookup_invoice to establish the facts. Do not process refunds. Finish " +
  "with only a JSON object: {concern_id, facts, root_cause, proposed_refund: {reference_id, amount, reason} or null}.";
const RESOLUTION_PROMPT =
  "ROLE: resolution writer\n" +
  "Write ONE reply to the customer that resolves every concern below, using the investigation results and the " +
  "actions already taken. Address the customer by name, cover each item, and state the total refunded.";

const DECOMPOSITION_SCHEMA = {
  type: "object",
  properties: {
    customer_email: { type: "string" },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          concern_id: { type: "string" },
          kind: { type: "string", enum: ["damaged_item", "billing_error", "delivery", "other"] },
          reference_id: { type: "string" },
          customer_words: { type: "string" },
        },
        required: ["concern_id", "kind", "reference_id", "customer_words"],
        additionalProperties: false,
      },
    },
  },
  required: ["customer_email", "concerns"],
  additionalProperties: false,
};
/** Investigators only read: refunds stay with the coordinator, behind the gate. */
const READ_ONLY_TOOLS = TOOLS.filter((t) => t.name === "lookup_order" || t.name === "lookup_invoice");

/** A request plus output_config (structured outputs), typed so it compiles with or without SDK support. */
type ApiRequest = lab.CreateParams & { output_config?: unknown };

type Concern = { concern_id: string; kind: string; reference_id: string; customer_words: string };
type ProposedRefund = { reference_id: string; amount: number; reason: string };
type Finding = { concern_id: string; facts: string; root_cause: string; proposed_refund: ProposedRefund | null };
type Action = { concern_id: string; tool: string; ok: boolean; result: Record<string, unknown> };

/** JSON from a reply that may wrap it in prose (live models sometimes do). */
function parseJsonReply(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  }
}

// ---------------------------------------------------------------------------
// Offline stand-ins, dispatched on the role tag of the system prompt
// ---------------------------------------------------------------------------

function decompose(params: lab.CreateParams): Anthropic.Message {
  const request = lab.lastUserText(params);
  const concerns: Concern[] = [];
  request.split(/\s+AND\s+/).forEach((clause, i) => {
    const ref = clause.match(/(ORD-\d+|INV-\d+)/);
    if (!ref) return;
    const kind = /double-charged|charged twice/.test(clause) ? "billing_error" : clause.includes("damaged") ? "damaged_item" : "other";
    const words = clause.split(/(?<=[.!?])\s+/).find((s) => s.includes(ref[1])) ?? clause;
    concerns.push({ concern_id: `c${i + 1}`, kind, reference_id: ref[1], customer_words: words.trim() });
  });
  const email = (request.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) ?? [""])[0];
  return lab.message([lab.text(JSON.stringify({ customer_email: email, concerns }))]);
}

function investigateTurn(params: lab.CreateParams): Anthropic.Message {
  const first = params.messages[0].content;
  const task = typeof first === "string" ? first : "";
  const concern = JSON.parse(tag(task, "concern")) as Concern;
  const results = lab.toolResults(params);
  const ref = concern.reference_id;
  if (results.length === 0) {
    const call = ref.startsWith("INV-") ? lab.toolUse("lookup_invoice", { invoice_id: ref }) : lab.toolUse("lookup_order", { order_id: ref });
    return lab.message([call]);
  }
  const raw = JSON.parse(lab.toolResultText(results[results.length - 1]));
  let finding: Finding;
  if (concern.kind === "billing_error") {
    const record = raw as Invoice;
    const seen = new Map<string, string>();
    const duplicates = record.charges.filter((charge) => {
      const key = `${charge.amount}|${charge.date}`;
      const isDuplicate = seen.has(key);
      if (!isDuplicate) seen.set(key, charge.charge_id);
      return isDuplicate;
    });
    const dup = duplicates[0];
    finding = {
      concern_id: concern.concern_id,
      facts: `${record.description}: ${record.charges.length} charges of $${dup.amount.toFixed(2)} on ${dup.date}`,
      root_cause: `Duplicate charge ${dup.charge_id} (same amount and date as ${seen.get(`${dup.amount}|${dup.date}`)})`,
      proposed_refund: {
        reference_id: ref,
        amount: Math.round(duplicates.reduce((s, d) => s + d.amount, 0) * 100) / 100,
        reason: "Duplicate charge",
      },
    };
  } else {
    const record = raw as Order;
    finding = {
      concern_id: concern.concern_id,
      facts: `${record.item}, $${record.total.toFixed(2)}, ${record.status} ${record.delivered_on}`,
      root_cause: "Damaged in transit (reported by the customer on arrival)",
      proposed_refund: { reference_id: ref, amount: record.total, reason: "Damaged on arrival" },
    };
  }
  return lab.message([lab.text(JSON.stringify(finding))]);
}

function resolve(params: lab.CreateParams): Anthropic.Message {
  const task = lab.lastUserText(params);
  const customer = JSON.parse(tag(task, "verified_customer")) as Customer;
  const findings = JSON.parse(tag(task, "investigations")) as Finding[];
  const actions = new Map((JSON.parse(tag(task, "actions")) as Action[]).map((a) => [a.concern_id, a] as const));
  const lines = [`Hi ${customer.name.split(" ")[0]}, I looked into both issues:`];
  let total = 0;
  findings.forEach((finding, i) => {
    const action = actions.get(finding.concern_id);
    let outcome = "passed to a specialist";
    if (action && action.ok) {
      const amount = Number(action.result.amount);
      total += amount;
      outcome = `refunded $${amount.toFixed(2)} (${String(action.result.refund_id)})`;
    }
    lines.push(`${i + 1}. ${finding.proposed_refund ? finding.proposed_refund.reference_id : finding.concern_id}: ${finding.root_cause} - ${outcome}.`);
  });
  lines.push(`Total refunded: $${total.toFixed(2)}, back to your original payment method.`);
  return lab.message([lab.text(lines.join("\n"))]);
}

const HANDLERS: Record<string, (params: lab.CreateParams) => Anthropic.Message> = {
  [DECOMPOSER_PROMPT.split("\n")[0]]: decompose,
  [INVESTIGATOR_PROMPT.split("\n")[0]]: investigateTurn,
  [RESOLUTION_PROMPT.split("\n")[0]]: resolve,
};

function scriptedTeam(params: lab.CreateParams): Anthropic.Message {
  return HANDLERS[lab.systemText(params).split("\n")[0]](params);
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

/** The shared verified context goes INTO each investigator's prompt (it has no other memory). */
function investigationTask(concern: Concern, verified: Record<string, unknown>): string {
  return (
    `<verified_customer>${JSON.stringify(verified)}</verified_customer>\n` +
    `<concern>${JSON.stringify(concern)}</concern>\n` +
    "Investigate this concern and return the JSON object."
  );
}

/** One concern, one small agent loop over read-only tools. */
async function investigate(client: lab.MessagesClient, tools: ToolLayer, concern: Concern, task: string): Promise<Finding> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: lab.MODEL, max_tokens: 16000, system: INVESTIGATOR_PROMPT, tools: READ_ONLY_TOOLS, messages,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return parseJsonReply(lab.textOf(response)) as Finding;
    const results = lab.toolUses(response).map((block): Anthropic.ToolResultBlockParam => {
      const [content, isError] = tools.execute(block.name, block.input as Record<string, unknown>); // same gate, already verified
      return { type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) };
    });
    messages.push({ role: "user", content: results });
  }
  throw new Error(`Investigation of ${concern.concern_id} did not finish`);
}

async function handle(client: lab.MessagesClient, tools: ToolLayer, request: string) {
  // 1. decompose
  const decomposeParams: ApiRequest = {
    model: lab.MODEL,
    max_tokens: 4000,
    system: DECOMPOSER_PROMPT,
    output_config: { format: { type: "json_schema", schema: DECOMPOSITION_SCHEMA } },
    messages: [{ role: "user", content: request }],
  };
  const decomposition = JSON.parse(lab.textOf(await client.messages.create(decomposeParams))) as { customer_email: string; concerns: Concern[] };
  const concerns = decomposition.concerns;

  // 2. verify once; the verified facts are the context every investigator shares
  const [content, isError] = tools.execute("get_customer", { email: decomposition.customer_email });
  if (isError) throw new Error(`verification failed: ${content}`);
  const verified = JSON.parse(content) as Record<string, unknown>;

  // 3. investigate every concern concurrently
  const t0 = Date.now();
  const timeline: Record<string, [number, number]> = {};
  const tasks: Record<string, string> = {};
  for (const c of concerns) tasks[c.concern_id] = investigationTask(c, verified);
  const findings = await Promise.all(
    concerns.map(async (concern) => {
      const start = (Date.now() - t0) / 1000;
      const finding = await investigate(client, tools, concern, tasks[concern.concern_id]);
      timeline[concern.concern_id] = [start, (Date.now() - t0) / 1000];
      return finding;
    }),
  );
  const investigationS = (Date.now() - t0) / 1000;

  // 4. act: refunds go through the gated tool layer, never straight to the backend
  const actions: Action[] = [];
  for (const finding of findings) {
    if (!finding.proposed_refund) continue;
    const [result, failed] = tools.execute("process_refund", { customer_id: verified.customer_id, ...finding.proposed_refund });
    actions.push({ concern_id: finding.concern_id, tool: "process_refund", ok: !failed, result: JSON.parse(result) as Record<string, unknown> });
  }

  // 5. one unified resolution
  const resolutionTask =
    `<verified_customer>${JSON.stringify(verified)}</verified_customer>\n` +
    `<concerns>${JSON.stringify(concerns)}</concerns>\n` +
    `<investigations>${JSON.stringify(findings)}</investigations>\n` +
    `<actions>${JSON.stringify(actions)}</actions>\n` +
    "Write the single reply to the customer.";
  const response = await client.messages.create({
    model: lab.MODEL, max_tokens: 16000, system: RESOLUTION_PROMPT, messages: [{ role: "user", content: resolutionTask }],
  });
  return { concerns, verified, tasks, findings, actions, reply: lab.textOf(response), timeline, investigationS };
}

lab.banner("D1.4  Multi-concern request: decompose, investigate in parallel, unify");
console.log(`user: ${REQUEST}`);
const tools = new ToolLayer(true);
const out = await handle(lab.getClient(scriptedTeam, LATENCY_MS), tools, REQUEST);

lab.section("1. Decomposition");
for (const c of out.concerns) console.log(`  ${c.concern_id} ${c.kind.padEnd(14)} ${c.reference_id.padEnd(9)} "${c.customer_words}"`);
lab.section("2. Shared context (verified once)");
console.log(`  ${JSON.stringify(out.verified)}`);
lab.section("3. Parallel investigations");
for (const f of out.findings) {
  const [start, end] = out.timeline[f.concern_id];
  console.log(`  ${f.concern_id} [${start.toFixed(2)}s -> ${end.toFixed(2)}s] ${f.root_cause}; proposed refund ${JSON.stringify(f.proposed_refund)}`);
}
console.log(`  investigation wall-clock: ${out.investigationS.toFixed(2)}s`);
lab.section("4. Actions through the gate");
for (const a of out.actions) console.log(`  ${a.concern_id} ${a.tool} ok=${a.ok} -> ${JSON.stringify(a.result)}`);
lab.section("5. Unified resolution");
console.log("  " + out.reply.replaceAll("\n", "\n  "));

const toolSequence = tools.calls.map((c) => c.tool);
console.log(`tool calls: ${JSON.stringify(toolSequence)}`);
lab.check(toolSequence.filter((t) => t === "get_customer").length === 1 && toolSequence[0] === "get_customer",
  "the customer was verified exactly once, before any investigation");
lab.check(tools.calls.every((c) => c.outcome === "ok"), "no call was blocked: investigators worked from the shared verified context");
lab.check(out.actions.length === out.concerns.length && out.actions.every((a) => a.ok), "each concern's refund went through the gated tool layer");
const verifiedId = String(out.verified.customer_id);
lab.check(Object.values(out.tasks).every((task) => task.includes(verifiedId)),
  `every investigator's prompt carried the shared verified customer (${verifiedId})`);
if (!lab.isLive()) {
  const refs = out.concerns.map((c) => c.reference_id).sort();
  lab.check(JSON.stringify(refs) === '["INV-77","ORD-1001"]', "decomposed into 2 distinct concerns: ORD-1001 and INV-77");
  const [[s1, e1], [s2, e2]] = Object.values(out.timeline);
  lab.check(Math.max(s1, s2) < Math.min(e1, e2), "the investigations overlapped in time (run concurrently)");
  lab.check(out.investigationS < ((2 * 2 * LATENCY_MS) / 1000) * 0.75,
    `parallel investigation took ${out.investigationS.toFixed(2)}s vs ~${((4 * LATENCY_MS) / 1000).toFixed(1)}s sequentially`);
  lab.check(out.reply.includes("ORD-1001") && out.reply.includes("INV-77") && out.reply.includes("$178.99"),
    "one reply resolves both concerns and states the total ($178.99)");
}
