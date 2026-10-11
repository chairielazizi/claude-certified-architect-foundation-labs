/**
 * D5.2 - Explicit demand vs frustrated-but-solvable, tracked across turns.
 *
 * Three conversations about the same dented kettle (a case the policy covers):
 *
 *   A  "Transfer me to a human agent now."        -> escalate immediately, no lookup first
 *   B  frustrated + "maybe I should talk to a person", then the customer repeats it
 *                                                 -> acknowledge + offer resolution, escalate on the repeat
 *   C  frustrated + the same hint, then accepts   -> acknowledge + offer, resolve, never escalate
 *
 * The decision depends on conversation STATE (how many times a human was requested, whether
 * a resolution was already offered), derived from the full history on every turn.
 *
 * Run:  npx tsx frustrationState.ts          (offline)
 *       npx tsx frustrationState.ts --live   (real API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { CRITERIA_PROMPT, conversationState, runConversation, scriptedModel, type ConversationResult } from "./supportAgent.ts";

const HINT = "My kettle ORD-7005 arrived dented AGAIN!! Photo attached. Honestly, maybe I should just talk to a person.";
const SCENARIOS: Record<string, string[]> = {
  "A - explicit demand": ["Transfer me to a human agent now. My kettle order ORD-7005 is a mess."],
  "B - frustrated hint, then repeated": [HINT, "I appreciate it, but maybe I should still talk to a person."],
  "C - frustrated hint, then accepts": [HINT, "OK fine, please send the replacement."],
};

lab.banner("D5.2  Frustration vs explicit requests: track conversation state");
const results: Record<string, ConversationResult> = {};
for (const [title, turns] of Object.entries(SCENARIOS)) {
  lab.section(title);
  const result = await runConversation(lab.getClient(scriptedModel), CRITERIA_PROMPT, turns, false);
  const history: Anthropic.MessageParam[] = [];
  turns.forEach((text, i) => {
    history.push({ role: "user", content: text });
    const state = conversationState({ messages: history });
    history.push({ role: "assistant", content: result.replies[i] });
    console.log(`  turn ${i + 1} user: ${text}`);
    console.log(
      `    state: human_mentions=${state.human_mentions} explicit_now=${state.explicit_now ? "True" : "False"} frustrated=${state.frustrated ? "True" : "False"}`,
    );
    console.log(`    tools: ${JSON.stringify(result.turnCalls[i])}\n    agent: ${result.replies[i]}`);
  });
  results[title[0]] = result;
}

const a = results.A;
const b = results.B;
const c = results.C;
lab.section("Checks");
if (lab.isLive()) {
  console.log("  live run: behaviour above comes from the real model; offline checks skipped");
} else {
  lab.check(JSON.stringify(a.calls) === '["escalate_to_human"]', "A: explicit demand escalated immediately, with no investigation first");
  lab.check(
    !b.turnCalls[0].includes("escalate_to_human") && b.replies[0].includes("replacement"),
    "B turn 1: frustration plus a hint got an acknowledgement and an offer, not an escalation",
  );
  lab.check(JSON.stringify(b.turnCalls[1]) === '["escalate_to_human"]', "B turn 2: the customer repeated the preference, so the agent escalated");
  lab.check(c.outcome === "resolve" && !c.calls.includes("escalate_to_human"), "C: the customer accepted the offer; resolved on first contact, never escalated");
  lab.check(c.replies[0].startsWith("I am sorry"), "the agent acknowledged the frustration before offering the fix");
}
