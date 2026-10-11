/**
 * D5.1 - Persistent case facts vs progressive summarization.
 *
 * A long, multi-issue support session is compressed the usual way: once the verbatim
 * buffer is full, the oldest turns are folded into a running summary. It runs twice:
 *
 *   A  naive       prompt = system + <conversation_summary> + recent turns
 *   B  case facts  prompt = system + <case_facts> + <open_issues> + <conversation_summary> + recent turns
 *
 * Both runs use the SAME summarizer. The only difference is that B extracts transactional
 * facts from every turn before that turn can be summarized, and injects them into every
 * prompt outside the summarized history.
 *
 * Run:  npx tsx caseFacts.ts          (offline, scripted summarizer + agent)
 *       npx tsx caseFacts.ts --live   (real API for both)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import {
  BUFFER_LIMIT,
  SUMMARIZE_BATCH,
  CaseFacts,
  IssueLayer,
  buildSystemPrompt,
  extractFacts,
  loadFixture,
  scriptedModel,
  summarize,
  type Conversation,
  type Turn,
} from "./contextLayers.ts";

const CRITICAL_FACTS = ["ORD-5521", "$89.90", "2026-10-02", "callback by Friday", "ORD-5590", "$24.50", "ORD-5602", "reversal_issued"];

interface SessionResult {
  summary: string;
  system: string;
  survival: Map<string, boolean>[];
  answer: string;
  facts: CaseFacts;
  issues: IssueLayer;
}

async function runSession(client: lab.MessagesClient, conversation: Conversation, withCaseFacts: boolean): Promise<SessionResult> {
  const facts = new CaseFacts();
  const issues = new IssueLayer();
  let summary = "";
  let buffer: Turn[] = [];
  let seenText = "";
  // Per round: for each critical fact mentioned so far, is it still in the NEXT request?
  const survival: Map<string, boolean>[] = [];

  for (const turn of conversation.turns) {
    if (withCaseFacts) extractFacts(turn, facts, issues); // before the turn can ever reach the summarizer
    buffer.push(turn);
    seenText += turn.text + "\n";
    if (buffer.length >= BUFFER_LIMIT) {
      summary = await summarize(client, summary, buffer.slice(0, SUMMARIZE_BATCH));
      buffer = buffer.slice(SUMMARIZE_BATCH);
      const view =
        buildSystemPrompt(summary, withCaseFacts ? facts : null, withCaseFacts ? issues : null) +
        "\n" +
        buffer.map((t) => t.text).join("\n");
      const row = new Map<string, boolean>();
      for (const fact of CRITICAL_FACTS) if (seenText.includes(fact)) row.set(fact, view.includes(fact));
      survival.push(row);
    }
  }

  const system = buildSystemPrompt(summary, withCaseFacts ? facts : null, withCaseFacts ? issues : null);
  const messages: Anthropic.MessageParam[] = buffer.map((t) => ({ role: t.role, content: t.text }));
  messages.push({ role: "user", content: conversation.final_question });
  const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system, messages });
  return { summary, system, survival, answer: lab.textOf(response), facts, issues };
}

const lost = (row: Map<string, boolean>) => [...row.entries()].filter(([, ok]) => !ok).map(([fact]) => fact);

lab.banner("D5.1  Case facts outside the summarized history");
const conversation = loadFixture("support_conversation.json") as Conversation;
console.log(
  `${conversation.turns.length} turns, 3 issues. Whenever ${BUFFER_LIMIT} turns are unsummarized, ` +
    `the oldest ${SUMMARIZE_BATCH} are folded into the running summary.`,
);

const runs: Record<string, SessionResult> = {};
for (const [key, title, useFacts] of [
  ["naive", "A - naive progressive summarization", false],
  ["facts", "B - same summarizer + case facts + issues layer", true],
] as const) {
  lab.section(title);
  const result = await runSession(lab.getClient(scriptedModel), conversation, useFacts);
  result.survival.forEach((row, i) => {
    const gone = lost(row);
    console.log(
      `  after round ${i + 1}: ${row.size - gone.length}/${row.size} critical facts mentioned so far are still in the prompt` +
        (gone.length ? `; lost ${JSON.stringify(gone)}` : ""),
    );
  });
  console.log(`user: ${conversation.final_question}`);
  console.log(`assistant: ${result.answer}`);
  runs[key] = result;
}

const naive = runs.naive;
const withFacts = runs.facts;
lab.section("What the final request contained");
console.log(`<conversation_summary> after ${naive.survival.length} rounds (identical in A and B offline):\n  ${withFacts.summary}`);
console.log(withFacts.facts.render());
console.log(withFacts.issues.render());

lab.section("Checks");
lab.check(withFacts.survival.length === 4, "the session went through 4 rounds of progressive summarization");
lab.check(
  withFacts.survival[withFacts.survival.length - 1].size === CRITICAL_FACTS.length &&
    withFacts.survival.every((row) => lost(row).length === 0),
  "B: every critical fact (amounts, dates, order IDs, statuses, the callback promise) survived every round",
);
lab.check(
  JSON.stringify(withFacts.issues.issues.map((i) => i.status)) === JSON.stringify(["refund_pending", "replacement_shipped", "reversal_issued"]),
  "B: the issues layer has one row per issue, each with its LATEST status",
);
lab.check(
  withFacts.system.includes("<case_facts>") && !withFacts.summary.includes("<case_facts>"),
  "B: the facts block is injected next to the summary, never inside it",
);
if (!lab.isLive()) {
  const gone = lost(naive.survival[naive.survival.length - 1]);
  lab.check(
    ["ORD-5521", "$89.90", "2026-10-02", "callback by Friday"].every((f) => gone.includes(f)),
    "A: the first issue's order ID, amount, delivery date and the customer's deadline were summarized away",
  );
  lab.check(naive.summary === withFacts.summary, "the summaries are identical: B did not need a better summarizer");
  const needed = ["ORD-5521", "$89.90", "ORD-5590", "$24.50", "ORD-5602", "$129.00", "callback by Friday"];
  lab.check(needed.every((x) => withFacts.answer.includes(x)), "B: the agent recapped all three issues and the promised callback");
  lab.check(
    !naive.answer.includes("ORD-5521") && !naive.answer.includes("callback by Friday"),
    "A: the agent could not recap the first issue or the promise it made",
  );
}
