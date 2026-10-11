/**
 * D5.2 - Sentiment and self-reported confidence are unreliable proxies for "needs a human".
 *
 * Every labelled case carries a logged sentiment score and the agent's self-reported
 * confidence. Three escalation policies are scored against the reviewers' labels:
 *
 *   sentiment rule      escalate when sentiment < -0.5         (sample Q3, option D)
 *   confidence rule     escalate when self_confidence < 6      (sample Q3, option B)
 *   explicit criteria   what the criteria-prompted agent actually did (escalate_to_human or not)
 *
 * Furious customers with covered problems do not need a human; polite customers asking for
 * something the policy does not cover do. And the agent is most confident exactly where it
 * is about to improvise policy.
 *
 * Run:  npx tsx unreliableProxies.ts          (offline)
 *       npx tsx unreliableProxies.ts --live   (criteria decisions from the real API)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { CRITERIA_PROMPT, loadFixture, pct, runConversation, scriptedModel, type Case } from "./supportAgent.ts";

const CASES = (loadFixture("cases.json") as { cases: Case[] }).cases;
const SENTIMENT_THRESHOLD = -0.5;
const CONFIDENCE_THRESHOLD = 6;

function score(predicted: boolean[], labels: boolean[]) {
  return {
    agree: predicted.filter((p, i) => p === labels[i]).length,
    missed: predicted.filter((p, i) => labels[i] && !p).length,
    unnecessary: predicted.filter((p, i) => p && !labels[i]).length,
  };
}
const yn = (flag: boolean) => (flag ? "ESC" : "-");

lab.banner("D5.2  Why sentiment and self-reported confidence are unreliable escalation proxies");
const labels = CASES.map((c) => c.expected === "escalate");
const bySentiment = CASES.map((c) => c.sentiment < SENTIMENT_THRESHOLD);
const byConfidence = CASES.map((c) => c.self_confidence < CONFIDENCE_THRESHOLD);
const byCriteria: boolean[] = [];
for (const c of CASES) {
  const result = await runConversation(lab.getClient(scriptedModel), CRITERIA_PROMPT, [c.message], false);
  byCriteria.push(result.outcome === "escalate");
}

lab.section("Per case (label = reviewer says a human is needed)");
console.log(`  ${"case".padEnd(5)}${"sentiment".padStart(10)}${"confidence".padStart(11)}  ${"label".padEnd(6)}${"sent.".padEnd(6)}${"conf.".padEnd(6)}${"criteria".padEnd(8)}  reason`);
CASES.forEach((c, i) => {
  const sentiment = (c.sentiment >= 0 ? "+" : "") + c.sentiment.toFixed(1);
  console.log(
    `  ${c.id.padEnd(5)}${sentiment.padStart(10)}${String(c.self_confidence).padStart(11)}  ` +
      `${yn(labels[i]).padEnd(6)}${yn(bySentiment[i]).padEnd(6)}${yn(byConfidence[i]).padEnd(6)}${yn(byCriteria[i]).padEnd(8)}  ${c.reason ?? ""}`,
  );
});

lab.section("Agreement with the labels");
const n = CASES.length;
const sent = score(bySentiment, labels);
const conf = score(byConfidence, labels);
const crit = score(byCriteria, labels);
console.log(`  ${"rule".padEnd(24)}${"agreement".padStart(12)}${"missed".padStart(8)}${"unneeded".padStart(10)}`);
for (const [rule, s] of [
  [`sentiment < ${SENTIMENT_THRESHOLD}`, sent],
  [`self_confidence < ${CONFIDENCE_THRESHOLD}`, conf],
  ["explicit criteria", crit],
] as const) {
  console.log(`  ${rule.padEnd(24)}${pct(s.agree, n).padStart(12)}${String(s.missed).padStart(8)}${String(s.unnecessary).padStart(10)}`);
}
const confidentButNeedsHuman = CASES.filter((c, i) => labels[i] && c.self_confidence >= 8).map((c) => c.id);
console.log(`  cases needing a human where the agent rated itself >= 8/10: ${JSON.stringify(confidentButNeedsHuman)}`);

lab.section("Checks");
lab.check(sent.agree * 2 < n && conf.agree * 2 < n, "both proxies agree with the labels on fewer than half the cases");
lab.check(sent.unnecessary >= 2 && sent.missed >= 4, "sentiment escalates furious-but-covered cases and misses calm policy requests");
lab.check(confidentButNeedsHuman.length >= 4, "self-reported confidence is highest on cases that need a human (it is not calibrated)");
if (!lab.isLive()) lab.check(crit.agree === n, "explicit criteria matched every label: escalate on the actual reasons, not on proxies");
