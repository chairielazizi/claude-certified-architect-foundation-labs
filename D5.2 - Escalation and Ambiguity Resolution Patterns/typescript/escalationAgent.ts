/**
 * D5.2 - Explicit escalation criteria + few-shot examples vs "escalate complex cases".
 *
 * Every labelled case in fixtures/cases.json runs through the same agent loop twice: once
 * with a vague system prompt and once with explicit criteria and few-shot examples (the
 * fix from sample question 3). Decisions are read from the tools the agent actually called
 * (escalate_to_human / a resolution tool / neither), never from its wording.
 *
 * Run:  npx tsx escalationAgent.ts          (offline, scripted model)
 *       npx tsx escalationAgent.ts --live   (real API on the same cases)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { BASELINE_PROMPT, CRITERIA_PROMPT, loadFixture, pct, runConversation, scriptedModel, type Case } from "./supportAgent.ts";

const CASES = (loadFixture("cases.json") as { cases: Case[] }).cases;
const SHORT: Record<string, string> = {
  lookup_order: "lookup",
  lookup_customer: "lookup",
  escalate_to_human: "escalate",
  issue_replacement: "replace",
  apply_price_adjustment: "adjust",
  issue_refund: "refund",
  "-": "-",
};

interface Row {
  id: string;
  expected: string;
  reason: string | null;
  outcome: string;
  firstCall: string;
  calls: string[];
}

async function evaluate(system: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of CASES) {
    const result = await runConversation(lab.getClient(scriptedModel), system, [c.message], false);
    rows.push({ id: c.id, expected: c.expected, reason: c.reason, outcome: result.outcome, firstCall: result.calls[0] ?? "-", calls: result.calls });
  }
  return rows;
}

function metrics(rows: Row[]): Record<string, string[]> {
  return {
    correct: rows.filter((r) => r.outcome === r.expected).map((r) => r.id),
    // Sample question 3's two symptoms:
    straightforward_escalated: rows.filter((r) => r.expected === "resolve" && r.outcome === "escalate").map((r) => r.id),
    policy_handled_alone: rows.filter((r) => (r.reason === "policy_gap" || r.reason === "policy_exception") && r.outcome !== "escalate").map((r) => r.id),
    // Explicit requests must be honoured before any investigation.
    explicit_not_immediate: rows.filter((r) => r.reason === "explicit_request" && r.firstCall !== "escalate_to_human").map((r) => r.id),
  };
}

lab.banner("D5.2  Explicit escalation criteria with few-shot examples");
const baseline = await evaluate(BASELINE_PROMPT);
const criteria = await evaluate(CRITERIA_PROMPT);

lab.section("Decisions per case (x = wrong; 1st = first tool called)");
console.log(`  ${"case".padEnd(5)} ${"expected".padEnd(9)} ${"vague prompt".padEnd(25)} ${"explicit criteria".padEnd(25)}`);
CASES.forEach((c, i) => {
  const cells = [baseline[i], criteria[i]].map((r) => `${r.outcome === r.expected ? " " : "x"} ${r.outcome.padEnd(8)} 1st=${SHORT[r.firstCall].padEnd(9)}`);
  console.log(`  ${c.id.padEnd(5)} ${c.expected.padEnd(9)} ${cells[0].padEnd(25)} ${cells[1].padEnd(25)} ${c.message.slice(0, 40)}`);
});

lab.section("Scorecard");
const mb = metrics(baseline);
const mc = metrics(criteria);
const n = CASES.length;
for (const [key, label] of [
  ["correct", "correct decisions"],
  ["straightforward_escalated", "straightforward cases escalated"],
  ["policy_handled_alone", "policy gaps/exceptions handled without a human"],
  ["explicit_not_immediate", "explicit human requests not honoured first"],
]) {
  const extraB = key === "correct" ? ` (${pct(mb[key].length, n)})` : "";
  const extraC = key === "correct" ? ` (${pct(mc[key].length, n)})` : "";
  console.log(`  ${label.padEnd(48)} vague: ${String(mb[key].length).padStart(2)}${extraB.padEnd(9)}  criteria: ${String(mc[key].length).padStart(2)}${extraC}`);
}
const mistakes = baseline.map((r) => r.id).filter((id) => !mb.correct.includes(id)).sort();
console.log(`  vague prompt mistakes: ${JSON.stringify(mistakes)}`);

lab.section("Checks");
if (lab.isLive()) {
  console.log("  live run: decisions above come from the real model; offline checks skipped");
} else {
  lab.check(mc.correct.length === n, "explicit criteria: every case got the expected decision");
  lab.check(
    mb.straightforward_escalated.length >= 3 && mb.policy_handled_alone.length >= 3,
    "vague prompt: escalated covered damage cases AND improvised policy exceptions (sample Q3's logs)",
  );
  lab.check(mc.explicit_not_immediate.length === 0, "explicit criteria: human requests escalated before any lookup");
  lab.check(mb.explicit_not_immediate.length === 2, "vague prompt: investigated first, then escalated the human requests");
  const replacementCases = criteria.filter((r) => r.calls.includes("issue_replacement")).map((r) => r.id);
  lab.check(
    JSON.stringify(replacementCases) === JSON.stringify(["C02", "C05", "C11"]),
    "explicit criteria: damage + photo resolved autonomously, even when the customer was furious (C05)",
  );
}
