/**
 * D5.2 - Multiple customer matches: ask for another identifier, never guess.
 *
 * lookup_customer(name="John Smith") returns three accounts. The criteria prompt tells the
 * agent to ask for an email or postal code before touching any account. The vague prompt
 * lets it pick by heuristic ("the most recently active account is probably them"), which
 * here discloses a different customer's order.
 *
 * Run:  npx tsx multipleMatches.ts          (offline)
 *       npx tsx multipleMatches.ts --live   (real API)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { BASELINE_PROMPT, CRITERIA_PROMPT, executeTool, runConversation, scriptedModel } from "./supportAgent.ts";

const TURNS = ["Hi, I'm John Smith. Has my latest order shipped?", "Sure, it's jsmith88@mail.com."];
const ACTUAL_ORDER = "ORD-7020"; // the caller is C-2002 (Denver); the heuristic picks C-2003 (Boston)

lab.banner("D5.2  Multiple matches: request an additional identifier");
const [matches] = executeTool("lookup_customer", { name: "John Smith" });
lab.show("lookup_customer(name='John Smith') returns", JSON.parse(matches));

lab.section("Explicit criteria: ask, then look up by the unique identifier");
const good = await runConversation(lab.getClient(scriptedModel), CRITERIA_PROMPT, TURNS);
TURNS.forEach((text, i) => console.log(`  user: ${text}\n  agent: ${good.replies[i]}`));

lab.section("Anti-pattern: pick one of the matches by heuristic");
const bad = await runConversation(lab.getClient(scriptedModel), BASELINE_PROMPT, TURNS.slice(0, 1));
console.log(`  user: ${TURNS[0]}\n  agent: ${bad.replies[0]}`);

lab.section("Checks");
if (lab.isLive()) {
  console.log("  live run: behaviour above comes from the real model; offline checks skipped");
} else {
  const first = good.replies[0];
  lab.check(
    JSON.stringify(good.turnCalls[0]) === '["lookup_customer"]' && first.includes("email address or postal code"),
    "criteria: three matches -> the agent asked for an additional identifier",
  );
  lab.check(!first.includes("ORD-"), "criteria: no account details were revealed while the match was ambiguous");
  lab.check(good.replies[1].includes(ACTUAL_ORDER), "criteria: the email gave a unique match and the right customer's order");
  lab.check(
    !bad.replies[0].includes(ACTUAL_ORDER) && bad.replies[0].includes("ORD-7031"),
    "heuristic: picked the most recent account and disclosed someone else's order",
  );
}
