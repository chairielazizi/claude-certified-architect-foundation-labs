/**
 * D2.2 - What the model does with each error style (Claude loop over the MCP tools).
 *
 * The tools are offered to Claude (TOOL_DEFS mirrors the shapes the McpServer registers),
 * every tool_use is executed by the tool handler, and the result's isError becomes the
 * tool_result's is_error. The same customer request runs against two servers:
 *   structured: business error + customerMessage -> explains the real reason, no retry
 *   generic:    "Operation failed"               -> can only retry blindly, then tells the
 *                                                   customer something vague (and wrong)
 *
 * Run:  npx tsx agentExplains.ts          (offline, scripted model turns)
 *       npx tsx agentExplains.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { resultText } from "./recoveryPolicy.ts";
import { Backend, TOOL_DEFS, makeHandlers, type Handler, type Style } from "./supportServer.ts";

const SYSTEM_PROMPT =
  "You are a support agent for an electronics store. Use the tools for real data and actions. " +
  "When a tool returns an error, decide from the error whether to retry, correct the input, " +
  "escalate, or explain the outcome to the customer. Never invent policies or reasons.";
const REQUEST = "Hi, my 4K monitor from order ORD-1001 arrived with dead pixels. Please refund the $900 I paid.";
const SAFETY_MAX_ITERATIONS = 10;

function lastToolInput(params: lab.CreateParams): Record<string, unknown> {
  let input: Record<string, unknown> = {};
  for (const m of params.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use") input = { ...(b.input as Record<string, unknown>) };
  }
  return input;
}

/** Offline stand-in: decides from the tool results in the conversation, like Claude would. */
function scriptedSupportModel(params: lab.CreateParams): Anthropic.Message {
  const first = params.messages[0].content;
  const request = typeof first === "string" ? first : "";
  const refundCalls = lab.allToolCalls(params).filter((n) => n === "process_refund").length;
  if (refundCalls === 0) {
    const orderId = request.match(/ORD-\d{4}/);
    const amount = request.match(/\$(\d+(?:\.\d+)?)/);
    return lab.message([
      lab.text("I'm sorry about the dead pixels - let me process that refund."),
      lab.toolUse("process_refund", { order_id: orderId ? orderId[0] : "", amount: amount ? Number(amount[1]) : 0 }),
    ]);
  }

  const results = lab.toolResults(params);
  const last = results[results.length - 1];
  const content = lab.toolResultText(last);
  if (!last.is_error) {
    const refund = JSON.parse(content) as { refund_id: string; amount: number };
    return lab.message([lab.text(`Done - refund ${refund.refund_id} for $${refund.amount.toFixed(2)} has been issued.`)]);
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(content) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const category = body.errorCategory;
  if (category === "business") {
    // The envelope says: not retryable, and here is what to tell the customer.
    return lab.message([lab.text(`I'm sorry about the monitor. ${String(body.customerMessage)} Shall I go ahead?`)]);
  }
  if (category === "transient" && body.isRetryable === true && refundCalls < 3) {
    return lab.message([lab.text("A brief hiccup - retrying."), lab.toolUse("process_refund", lastToolInput(params))]);
  }
  if (category === "permission" || category === "validation") {
    return lab.message([lab.text(`I can't complete this myself (${String(body.message)}). I'm passing it to a colleague.`)]);
  }

  // Unstructured "Operation failed": no way to know whether a retry could help.
  if (refundCalls < 3) {
    return lab.message([lab.text("That didn't go through - let me try again."), lab.toolUse("process_refund", lastToolInput(params))]);
  }
  return lab.message([lab.text("I'm sorry, our refund system is having technical problems. Please try again later.")]);
}

async function runAgent(client: lab.MessagesClient, handlers: Record<string, Handler>): Promise<{ answer: string; messages: Anthropic.MessageParam[] }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: REQUEST }];
  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFS as unknown as Anthropic.Tool[],
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return { answer: lab.textOf(response), messages };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of lab.toolUses(response)) {
      const handler = handlers[block.name];
      const result = handler
        ? await handler(block.input as Record<string, unknown>)
        : { content: [{ type: "text" as const, text: JSON.stringify({ error: `unknown tool ${block.name}` }) }], isError: true };
      const text = resultText(result);
      console.log(`    ${block.name}(${JSON.stringify(block.input)}) -> isError=${result.isError === true} ${text.slice(0, 90)}`);
      // The MCP isError flag becomes the Messages API is_error flag.
      results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: result.isError === true });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("agent did not finish");
}

function toolCalls(messages: Anthropic.MessageParam[], name: string): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use" && b.name === name) n++;
  }
  return n;
}

lab.banner("D2.2  How the model reacts to structured vs generic MCP errors");
console.log(`customer: ${REQUEST}`);
const outcomes: Record<string, { answer: string; messages: Anthropic.MessageParam[] }> = {};
for (const style of ["structured", "generic"] as Style[]) {
  lab.section(`${style} error responses`);
  const outcome = await runAgent(lab.getClient(scriptedSupportModel), makeHandlers(new Backend(), style));
  console.log(`  agent -> customer: ${outcome.answer}`);
  outcomes[style] = outcome;
}

lab.section("Checks");
lab.check(Object.values(outcomes).every((o) => o.answer.length > 0), "both runs ended with an answer for the customer (end_turn)");
if (!lab.isLive()) {
  const s = outcomes["structured"];
  const g = outcomes["generic"];
  const firstUserReply = s.messages[2];
  const firstResult =
    typeof firstUserReply.content === "string"
      ? undefined
      : firstUserReply.content.find((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
  lab.check(
    firstResult !== undefined &&
      firstResult.is_error === true &&
      JSON.parse(lab.toolResultText(firstResult)).errorCategory === "business",
    "MCP isError reached the model as tool_result is_error=true, with the envelope as content",
  );
  lab.check(
    toolCalls(s.messages, "process_refund") === 1 && s.answer.includes("supervisor"),
    "structured: one call, customer hears the real reason (supervisor approval over $500)",
  );
  lab.check(toolCalls(g.messages, "process_refund") === 3, "generic: the model retried a policy refusal twice (wasted calls)");
  lab.check(g.answer.includes("technical") && !g.answer.includes("500"), "generic: the customer is told a wrong reason ('technical problems')");
}
