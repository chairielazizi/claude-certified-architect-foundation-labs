/**
 * D5.1 - Trim verbose tool output before it accumulates in context.
 *
 * lookup_order returns 47 fields; a returns conversation needs 5 of them. Every tool result
 * stays in the history and is re-sent with every later request, so the waste compounds
 * over a session. The fix lives in the tool executor: keep only the relevant fields BEFORE
 * the result is appended to the conversation.
 *
 * (In the Agent SDK the same trim can be done in a PostToolUse hook that returns
 * `updatedToolOutput`; see D1.5.)
 *
 * Run:  npx tsx toolOutputTrimming.ts          (offline)
 *       npx tsx toolOutputTrimming.ts --live   (real API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { loadFixture } from "./contextLayers.ts";

type OrderRecord = Record<string, unknown>;
const ORDERS = loadFixture("order_lookup.json") as { template: OrderRecord; orders: Record<string, OrderRecord> };
const RETURN_FIELDS = ["order_id", "item_names", "total", "delivered_on", "return_window_ends"];
const TODAY = "2026-10-11";

const SYSTEM =
  "You are a returns assistant for an electronics store. Today is 2026-10-11. Call lookup_order " +
  "for every order the customer asks about. An order can be returned on or before its " +
  "return_window_ends date. Answer in one sentence per order.";
const TOOLS: Anthropic.Tool[] = [
  {
    name: "lookup_order",
    description:
      "Fetch one order by its ID (format ORD-####). Returns the order record, including items, total, delivery date and return window end date.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string", description: "Order ID, e.g. ORD-5521" } },
      required: ["order_id"],
    },
  },
];
const TURNS = [
  "I'd like to return the headphones from ORD-5521.",
  "What about ORD-5590?",
  "And ORD-5602?",
  "Finally, can I still return ORD-5477?",
];

const fullRecord = (orderId: string): OrderRecord => ({ ...ORDERS.template, ...ORDERS.orders[orderId] });

function trimForReturns(record: OrderRecord): OrderRecord {
  const out: OrderRecord = {};
  for (const field of RETURN_FIELDS) out[field] = record[field];
  return out;
}

function executeLookup(orderId: string, trim: boolean): [string, boolean] {
  if (!(orderId in ORDERS.orders)) return [JSON.stringify({ error: `No order ${orderId}` }), true];
  const record = fullRecord(orderId);
  return [JSON.stringify(trim ? trimForReturns(record) : record), false];
}

interface ReturnFields {
  order_id: string;
  item_names: string[];
  total: string;
  return_window_ends: string;
}

function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const results = lab.toolResults(params);
  if (results.length) {
    const order = JSON.parse(lab.toolResultText(results[results.length - 1])) as ReturnFields;
    const windowEnds = order.return_window_ends;
    const head = `${order.order_id} (${order.item_names.join(", ")}, $${order.total})`;
    if (TODAY <= windowEnds) return lab.message([lab.text(`${head} can be returned until ${windowEnds}.`)]); // ISO dates compare as strings
    return lab.message([lab.text(`${head} is past its return window, which ended on ${windowEnds}.`)]);
  }
  const orderId = lab.lastUserText(params).match(/ORD-\d{4}/);
  if (orderId) return lab.message([lab.toolUse("lookup_order", { order_id: orderId[0] })]);
  return lab.message([lab.text("Which order would you like to return?")]);
}

function toolOutputChars(messages: Anthropic.MessageParam[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const b of msg.content) if (b.type === "tool_result") total += lab.toolResultText(b).length;
  }
  return total;
}

async function runSession(client: lab.MessagesClient, trim: boolean) {
  const messages: Anthropic.MessageParam[] = [];
  const answers: string[] = [];
  const resent: number[] = []; // tool-output chars carried by each request
  for (const text of TURNS) {
    messages.push({ role: "user", content: text });
    while (true) {
      resent.push(toolOutputChars(messages));
      const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages: [...messages] });
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") {
        // loop control simplified; D1.1 covers every stop_reason
        answers.push(lab.textOf(response));
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of lab.toolUses(response)) {
        const input = block.input as { order_id?: string };
        const [content, isError] = executeLookup(input.order_id ?? "", trim);
        results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  }
  return { answers, historyChars: toolOutputChars(messages), resentChars: resent.reduce((a, b) => a + b, 0), requests: resent.length };
}

lab.banner("D5.1  Trim verbose tool output before it accumulates");
const record = fullRecord("ORD-5521");
const trimmed = trimForReturns(record);
console.log(
  `lookup_order returns ${Object.keys(record).length} fields (${JSON.stringify(record).length} chars); returns need ${Object.keys(trimmed).length}:`,
);
console.log(`  ${JSON.stringify(trimmed)}`);

lab.section("A - append the full 47-field record");
const full = await runSession(lab.getClient(scriptedModel), false);
TURNS.forEach((q, i) => console.log(`  user: ${q}\n    assistant: ${full.answers[i]}`));
lab.section("B - trim to return-relevant fields first");
const trim = await runSession(lab.getClient(scriptedModel), true);
TURNS.forEach((q, i) => console.log(`  user: ${q}\n    assistant: ${trim.answers[i]}`));

lab.section("Context cost over the session");
const fmt = (n: number) => n.toLocaleString("en-US").padStart(10);
const rows: [string, number, number][] = [
  ["fields kept per lookup", Object.keys(record).length, Object.keys(trimmed).length],
  ["tool-output chars in final history", full.historyChars, trim.historyChars],
  [`tool-output chars re-sent over ${full.requests} requests`, full.resentChars, trim.resentChars],
  ["~tokens re-sent (chars / 4)", Math.ceil(full.resentChars / 4), Math.ceil(trim.resentChars / 4)],
];
console.log(`  ${"".padEnd(44)}${"full".padStart(10)}${"trimmed".padStart(10)}`);
for (const [label, a, b] of rows) console.log(`  ${label.padEnd(44)}${fmt(a)}${fmt(b)}`);
const saved = 100 - Math.floor((trim.resentChars * 100) / full.resentChars);
console.log(`  saved: ${saved}% of the tool-output context`);

lab.section("Checks");
lab.check(Object.keys(record).length >= 40 && Object.keys(trimmed).length === 5, "the raw lookup has 40+ fields; the trimmed one keeps 5");
lab.check(trim.historyChars * 5 <= full.historyChars, "trimmed results take at most 20% of the space in the history");
lab.check(saved >= 80, "over the session, trimming saved at least 80% of the re-sent tool output");
if (!lab.isLive()) {
  lab.check(JSON.stringify(full.answers) === JSON.stringify(trim.answers), "answers are identical: the 5 fields carried everything the task needed");
  lab.check(trim.answers[trim.answers.length - 1].includes("past its return window"), "the return-window logic still works on the trimmed record");
}
