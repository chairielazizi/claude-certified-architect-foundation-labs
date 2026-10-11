/**
 * D1.1 - Loop-termination anti-patterns the exam calls out, and how each one breaks.
 *
 * Every broken loop runs against the same scripted model as agenticLoop.ts, so the only
 * variable is the control flow. This file always runs offline: two of the anti-patterns
 * would send malformed conversations to the real API.
 *
 * Run:  npx tsx antiPatterns.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { runAgent } from "./agenticLoop.ts";
import { SYSTEM_PROMPT, TOOLS, executeTool, scriptedModel } from "./supportBackend.ts";

const REQUEST = "Hi, I'm alice@example.com. Has my order arrived?";
const CAP = 6;

const call = (client: lab.ScriptedClient, messages: Anthropic.MessageParam[]) =>
  client.messages.create({ model: lab.MODEL, max_tokens: 16000, system: SYSTEM_PROMPT, tools: TOOLS, messages });

function runTools(response: Anthropic.Message): Anthropic.MessageParam {
  const content: Anthropic.ToolResultBlockParam[] = lab.toolUses(response).map((block) => ({
    type: "tool_result",
    tool_use_id: block.id,
    content: executeTool(block.name, block.input as Record<string, unknown>)[0],
  }));
  return { role: "user", content };
}

/** BAD: treats "the response contains text" as completion. */
async function antiPatternTextMeansDone(client: lab.ScriptedClient): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: REQUEST }];
  while (true) {
    const response = await call(client, messages);
    if (lab.textOf(response)) return lab.textOf(response); // <- wrong signal: text often accompanies tool_use
    messages.push({ role: "assistant", content: response.content }, runTools(response));
  }
}

/** BAD: an arbitrary iteration cap is the primary stopping mechanism. */
async function antiPatternIterationCap(client: lab.ScriptedClient, maxIterations = 2): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: REQUEST }];
  let lastText = "";
  for (let i = 0; i < maxIterations; i++) {
    // <- stops on a count, not on what the model said
    const response = await call(client, messages);
    lastText = lab.textOf(response) || lastText;
    messages.push({ role: "assistant", content: response.content }, runTools(response));
  }
  return lastText;
}

/** BAD: scans the reply for a natural-language "I'm done" phrase. */
async function antiPatternParsePhrase(client: lab.ScriptedClient): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: REQUEST }];
  let reply = "";
  for (let i = 0; i < CAP; i++) {
    const response = await call(client, messages);
    reply = lab.textOf(response);
    if (/final answer|i'm done/i.test(reply)) return reply; // <- brittle string match
    messages.push({ role: "assistant", content: response.content });
    if (lab.toolUses(response).length) messages.push(runTools(response));
    // Without tool calls this re-sends a conversation that ends on an assistant turn,
    // which the real API rejects. It only "works" here because the model is scripted.
  }
  return `<gave up after ${CAP} calls; last reply: ${JSON.stringify(reply)}>`;
}

/** BAD (for open-ended tasks): a hard-coded tool sequence instead of model-driven choice. */
function antiPatternFixedDecisionTree(request: string): string {
  const email = request.split(/\s+/).find((w) => w.includes("@")) ?? "";
  const [customer, isError] = executeTool("get_customer", { email }); // always step 1
  return isError ? `<pipeline failed at step 1 get_customer: ${customer}>` : "<would continue with lookup_order ...>";
}

lab.banner("D1.1  Loop-termination anti-patterns (always offline)");
console.log(`user: ${REQUEST}`);

lab.section("Correct: continue on tool_use, stop on end_turn");
const goodClient = new lab.ScriptedClient(scriptedModel);
const { answer: good } = await runAgent(goodClient, REQUEST);
console.log(`answer: ${good}\nAPI calls: ${goodClient.calls.length}`);

lab.section("Anti-pattern 1: 'response has text' means done");
const c1 = new lab.ScriptedClient(scriptedModel);
const bad1 = await antiPatternTextMeansDone(c1);
console.log(`answer: ${bad1}`);
lab.check(bad1 !== good && c1.calls.length === 1, "stopped on the first turn; no tool ever ran");

lab.section("Anti-pattern 2: arbitrary iteration cap as the stop condition");
const bad2 = await antiPatternIterationCap(new lab.ScriptedClient(scriptedModel));
console.log(`answer: ${bad2}`);
lab.check(bad2 !== good, "cap hit mid-task; the user gets a progress note instead of an answer");

lab.section("Anti-pattern 3: parsing natural language for termination");
const c3 = new lab.ScriptedClient(scriptedModel);
const bad3 = await antiPatternParsePhrase(c3);
console.log(`answer: ${bad3}`);
lab.check(c3.calls.length === CAP, `the model never said the magic phrase, so all ${CAP} calls were spent`);

lab.section("Anti-pattern 4: pre-configured decision tree instead of model-driven choice");
const requestB = "Where is order ORD-5521?";
console.log(`user: ${requestB}`);
const bad4 = antiPatternFixedDecisionTree(requestB);
console.log(`answer: ${bad4}`);
const { answer: good4 } = await runAgent(new lab.ScriptedClient(scriptedModel), requestB);
console.log(`model-driven loop instead: ${good4}`);
lab.check(bad4.startsWith("<pipeline failed") && good4.includes("ORD-5521"), "fixed sequence broke; the model adapted");
