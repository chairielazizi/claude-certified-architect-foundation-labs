/**
 * D5.1 - The Messages API is stateless: send the complete history on every request.
 *
 * The model knows only what is in the request. A chat loop must append every user and
 * assistant turn and re-send the whole list each time. The anti-pattern (send only the
 * newest message and assume the server remembers) breaks coherence on the next turn.
 *
 * Run:  npx tsx statelessHistory.ts          (offline)
 *       npx tsx statelessHistory.ts --live   (real API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

const SYSTEM = "You are a concise customer support agent for an electronics store.";
const TURNS = [
  "My order ORD-5521 cost $89.90 and the headphones stopped working.",
  "I'd like a refund rather than a replacement.",
  "How much will I get back, and for which order?",
];

/** Answers from whatever user turns are in THIS request; it has no other memory. */
function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const said = params.messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join(" ");
  const latest = lab.lastUserText(params).toLowerCase();
  const order = said.match(/ORD-\d{4}/);
  const amount = said.match(/\$\d+\.\d{2}/);
  let reply: string;
  if (latest.includes("how much")) {
    reply =
      order && amount
        ? `You will get ${amount[0]} back for ${order[0]} once the refund is approved.`
        : "Could you tell me which order this is about and how much you paid?";
  } else if (latest.includes("refund")) {
    reply = order ? `No problem, I will start a refund for ${order[0]}.` : "Happy to help. Which order should I refund?";
  } else {
    reply = order ? `Sorry to hear that. Would you like a refund or a replacement for ${order[0]}?` : "How can I help?";
  }
  return lab.message([lab.text(reply)]);
}

async function chat(client: lab.MessagesClient, sendFullHistory: boolean) {
  const history: Anthropic.MessageParam[] = [];
  const answers: string[] = [];
  const sentSizes: number[] = [];
  for (const text of TURNS) {
    history.push({ role: "user", content: text });
    // Copy the list: the request must be a snapshot, and the full list is the ONLY memory.
    const request = sendFullHistory ? [...history] : [history[history.length - 1]];
    sentSizes.push(request.length);
    const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system: SYSTEM, messages: request });
    history.push({ role: "assistant", content: response.content }); // keep the full turn
    answers.push(lab.textOf(response));
    console.log(`  sent ${request.length} message(s) | user: ${text}\n    assistant: ${answers[answers.length - 1]}`);
  }
  return { answers, sentSizes, history };
}

lab.banner("D5.1  Stateless API: pass the full conversation history every time");

lab.section("Correct: re-send the whole history on every request");
const good = await chat(lab.getClient(scriptedModel), true);
console.log(`  roles in the last request: ${JSON.stringify(good.history.slice(0, -1).map((m) => m.role))}`);

lab.section("Anti-pattern: send only the newest message");
const bad = await chat(lab.getClient(scriptedModel), false);

lab.section("Checks");
lab.check(JSON.stringify(good.sentSizes) === "[1,3,5]", "each request carried the complete history (1, 3, 5 messages)");
lab.check(JSON.stringify(bad.sentSizes) === "[1,1,1]", "the anti-pattern sent a single message each time");
if (!lab.isLive()) {
  const last = good.answers[good.answers.length - 1];
  lab.check(last.includes("$89.90") && last.includes("ORD-5521"), "with full history the model answered with the amount and order from turn 1");
  lab.check(!bad.answers[bad.answers.length - 1].includes("$89.90"), "without history the model had to ask again: the API remembers nothing");
}
