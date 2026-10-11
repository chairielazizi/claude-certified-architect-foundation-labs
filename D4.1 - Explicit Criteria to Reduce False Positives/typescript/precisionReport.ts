/**
 * D4.1 - Measure precision per category, see the trust damage, toggle the noisy category off.
 *
 *   labelled findings -> precision per category -> one noisy category drags down the rest
 *                     -> developers start ignoring REAL bugs too
 *                     -> disable that category (toggle) while its criteria get rewritten
 *
 * Pure analysis over fixtures/historical_findings.json; no model calls.
 *
 * Run:  npx tsx precisionReport.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  DEFAULT_TOGGLES,
  buildExplicitPrompt,
  categoriesToDisable,
  loadJson,
  overallPrecision,
  pct,
  precisionByCategory,
  type LabelledFinding,
} from "./reviewCriteria.ts";

/** Share of REAL issues (audit label) that developers dismissed anyway. */
function ignoredTruePositiveRate(findings: LabelledFinding[], weeks: Set<number>, categories: Set<string>): number {
  const real = findings.filter((f) => weeks.has(f.week) && categories.has(f.category) && f.label === "true_positive");
  return real.length ? real.filter((f) => f.developer_action === "dismissed").length / real.length : 0;
}

lab.banner("D4.1  Precision per category and category toggles");
const findings = loadJson<{ findings: LabelledFinding[] }>("historical_findings.json").findings;

lab.section("1. Precision per category (4 weeks, audited labels)");
const stats = precisionByCategory(findings);
console.log(`  ${"category".padEnd(18)}${"reported".padStart(9)}${"true pos".padStart(10)}${"precision".padStart(11)}`);
for (const [name, s] of Object.entries(stats).sort((a, b) => a[1].precision - b[1].precision)) {
  console.log(`  ${name.padEnd(18)}${String(s.reported).padStart(9)}${String(s.true_positives).padStart(10)}${pct(s.precision).padStart(11)}`);
}
const baseline = overallPrecision(findings);
const totalTp = Object.values(stats).reduce((n, s) => n + s.true_positives, 0);
console.log(`  ${"OVERALL".padEnd(18)}${String(findings.length).padStart(9)}${String(totalTp).padStart(10)}${pct(baseline).padStart(11)}`);

lab.check(stats.comment_accuracy.precision < 0.5, "comment_accuracy is mostly noise (precision below 50%)");
lab.check(
  ["bug", "security", "performance"].every((c) => stats[c].precision >= 0.6),
  "bug, security and performance findings are mostly right",
);

lab.section("2. The trust cost: real issues get ignored too");
const accurate = new Set(Object.entries(stats).filter(([, s]) => s.precision >= 0.6).map(([c]) => c));
const early = ignoredTruePositiveRate(findings, new Set([1, 2]), accurate);
const late = ignoredTruePositiveRate(findings, new Set([3, 4]), accurate);
console.log(`  real bug/security/performance findings dismissed, weeks 1-2: ${pct(early)}`);
console.log(`  real bug/security/performance findings dismissed, weeks 3-4: ${pct(late)}`);
console.log("  -> after weeks of wording nitpicks, developers dismiss findings without reading them.");
lab.check(late > early, "false positives in one category eroded trust in the ACCURATE categories");

lab.section("3. Toggle the high-false-positive category off");
const noisy = categoriesToDisable(stats, 0.6, 5);
const toggles: Record<string, boolean> = { ...DEFAULT_TOGGLES };
for (const c of noisy) toggles[c] = false;
lab.show("categories to disable", noisy);
lab.show("toggles", toggles);
const kept = new Set(Object.entries(toggles).filter(([, on]) => on).map(([c]) => c));
const projected = overallPrecision(findings, kept);
console.log(`  overall precision: ${pct(baseline)} -> ${pct(projected)} with ${JSON.stringify(noisy)} disabled`);
const recallCost = findings.filter((f) => noisy.includes(f.category) && f.label === "true_positive").length;
console.log(`  cost: ${recallCost} real comment contradictions will go unreported until the category returns`);
lab.check(JSON.stringify(noisy) === '["comment_accuracy"]', "only the category with enough data AND low precision is disabled");
lab.check(projected > baseline + 0.15, "disabling it raises overall precision substantially");

lab.section("4. The generated prompt reflects the toggles");
const prompt = buildExplicitPrompt(toggles);
console.log(prompt);
const reportBlock = prompt.split("REPORT only these categories:")[1].split("\n\n")[0];
lab.check(!reportBlock.includes("comment_accuracy"), "comment_accuracy is no longer in the REPORT list");
lab.check(
  prompt.includes("- comment_accuracy: temporarily disabled"),
  "it is listed under SKIP as temporarily disabled, so the model actively skips it",
);
