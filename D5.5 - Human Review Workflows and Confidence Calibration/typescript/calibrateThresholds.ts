/**
 * D5.5 - Calibrate per-field confidence thresholds on a labelled set, then gate automation.
 *
 * The model emits a confidence score for every extracted field. Raw scores are not
 * probabilities, so each segment (doc type x field) gets its own threshold: the LOWEST
 * confidence at which the auto-accepted set is still at least 99% correct on the labelled
 * validation set, with at least 30 items above it and never below 50.
 *
 * The gate: only segments with such a threshold get reduced human review. A segment where
 * no threshold reaches 99% (contract.effective_date: its errors are as confident as its
 * correct answers) stays in full human review. A single global threshold would also hit
 * 99% overall while letting that segment through at well under 90%.
 *
 * Run:  npx tsx calibrateThresholds.ts      (pure computation; identical output in Python)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  MIN_SUPPORT,
  TARGET_PRECISION_PCT,
  VALIDATION_COUNTS,
  VALIDATION_SEED,
  calibrate,
  calibrateAll,
  generate,
  pct,
  precisionAt,
  segments,
  type Calibration,
} from "./reviewData.ts";

lab.banner("D5.5  Per-field threshold calibration and the automation gate");
const items = generate(VALIDATION_SEED, VALIDATION_COUNTS);
const groups = segments(items);
const thresholds = calibrateAll(items);
console.log(`target: auto-accepted precision >= ${TARGET_PRECISION_PCT}% with >= ${MIN_SUPPORT} validation items above the threshold`);

lab.section("Per-segment calibration");
console.log(
  `  ${"segment".padEnd(26)}${"accuracy".padStart(9)}${"threshold".padStart(11)}${"precision".padStart(11)}${"auto-accept".padStart(13)}  decision`,
);
for (const [segment, group] of groups) {
  const ok = group.filter((x) => x.correct).length;
  const t = thresholds.get(segment) ?? null;
  if (t === null) {
    console.log(`  ${segment.padEnd(26)}${pct(ok, group.length).padStart(9)}${"none".padStart(11)}${"-".padStart(11)}${"0.0%".padStart(13)}  HUMAN REVIEW (gate failed)`);
  } else {
    console.log(
      `  ${segment.padEnd(26)}${pct(ok, group.length).padStart(9)}${String(t.threshold).padStart(11)}${pct(t.correct, t.accepted).padStart(11)}` +
        `${pct(t.accepted, t.total).padStart(13)}  automate at >= ${t.threshold}`,
    );
  }
}

lab.section("What a single global threshold would do");
const pooled = calibrate(items);
if (!pooled) throw new Error("pooled calibration failed");
console.log(`  pooled calibration -> threshold ${pooled.threshold}, overall precision ${pct(pooled.correct, pooled.accepted)}`);
for (const [segment, group] of groups) {
  const [ok, n] = precisionAt(group, pooled.threshold);
  if (ok * 100 < TARGET_PRECISION_PCT * n) {
    console.log(`  ${segment.padEnd(26)} precision at ${pooled.threshold}: ${pct(ok, n)} (${ok}/${n})  <-- misses the target`);
  }
}

lab.section("Checks");
const calibrated = [...thresholds.values()].filter((t): t is Calibration => t !== null);
lab.check(
  calibrated.every((t) => t.correct * 100 >= TARGET_PRECISION_PCT * t.accepted && t.accepted >= MIN_SUPPORT),
  "every automated segment meets 99% precision on at least 30 validation items",
);
lab.check(thresholds.get("contract.effective_date") === null, "contract.effective_date has no threshold that reaches 99%: it stays in human review");
lab.check(calibrated.length === groups.size - 1, "the gate reduces review for every other segment");
const values = calibrated.map((t) => t.threshold);
lab.check(Math.min(...values) < Math.max(...values) - 25, "calibrated thresholds differ widely by segment (one number does not fit all)");
const [effOk, effN] = precisionAt(groups.get("contract.effective_date") ?? [], pooled.threshold);
lab.check(
  pooled.correct * 100 >= TARGET_PRECISION_PCT * pooled.accepted && effOk * 10 < 9 * effN,
  "a global threshold hits 99% overall yet auto-accepts effective_date at under 90%",
);
