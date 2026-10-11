"""D5.5 - Calibrate per-field confidence thresholds on a labelled set, then gate automation.

The model emits a confidence score for every extracted field. Raw scores are not
probabilities, so each segment (doc type x field) gets its own threshold: the LOWEST
confidence at which the auto-accepted set is still at least 99% correct on the labelled
validation set, with at least 30 items above it and never below 50.

The gate: only segments with such a threshold get reduced human review. A segment where
no threshold reaches 99% (contract.effective_date: its errors are as confident as its
correct answers) stays in full human review. A single global threshold would also hit
99% overall while letting that segment through at well under 90%.

Run:  python calibrate_thresholds.py      (pure computation; identical output in TypeScript)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_data import (  # noqa: E402
    MIN_SUPPORT,
    TARGET_PRECISION_PCT,
    VALIDATION_COUNTS,
    VALIDATION_SEED,
    calibrate,
    calibrate_all,
    generate,
    pct,
    precision_at,
    segments,
)


def main() -> None:
    lab.banner("D5.5  Per-field threshold calibration and the automation gate")
    items = generate(VALIDATION_SEED, VALIDATION_COUNTS)
    groups = segments(items)
    thresholds = calibrate_all(items)
    print(f"target: auto-accepted precision >= {TARGET_PRECISION_PCT}% with >= {MIN_SUPPORT} validation items above the threshold")

    lab.section("Per-segment calibration")
    print(f"  {'segment':26}{'accuracy':>9}{'threshold':>11}{'precision':>11}{'auto-accept':>13}  decision")
    for segment, group in groups.items():
        ok = sum(1 for x in group if x["correct"])
        t = thresholds[segment]
        if t is None:
            print(f"  {segment:26}{pct(ok, len(group)):>9}{'none':>11}{'-':>11}{'0.0%':>13}  HUMAN REVIEW (gate failed)")
        else:
            print(f"  {segment:26}{pct(ok, len(group)):>9}{t['threshold']:>11}{pct(t['correct'], t['accepted']):>11}"
                  f"{pct(t['accepted'], t['total']):>13}  automate at >= {t['threshold']}")

    lab.section("What a single global threshold would do")
    pooled = calibrate(items)
    assert pooled is not None
    print(f"  pooled calibration -> threshold {pooled['threshold']}, overall precision {pct(pooled['correct'], pooled['accepted'])}")
    failing = []
    for segment, group in groups.items():
        ok, n = precision_at(group, pooled["threshold"])
        if ok * 100 < TARGET_PRECISION_PCT * n:
            failing.append(segment)
            print(f"  {segment:26} precision at {pooled['threshold']}: {pct(ok, n)} ({ok}/{n})  <-- misses the target")

    lab.section("Checks")
    automated = [s for s, t in thresholds.items() if t is not None]
    lab.check(
        all(t["correct"] * 100 >= TARGET_PRECISION_PCT * t["accepted"] and t["accepted"] >= MIN_SUPPORT for t in thresholds.values() if t),
        "every automated segment meets 99% precision on at least 30 validation items",
    )
    lab.check(thresholds["contract.effective_date"] is None, "contract.effective_date has no threshold that reaches 99%: it stays in human review")
    lab.check(len(automated) == len(groups) - 1, "the gate reduces review for every other segment")
    values = [t["threshold"] for t in thresholds.values() if t]
    lab.check(min(values) < max(values) - 25, "calibrated thresholds differ widely by segment (one number does not fit all)")
    ok, n = precision_at(groups["contract.effective_date"], pooled["threshold"])
    lab.check(
        pooled["correct"] * 100 >= TARGET_PRECISION_PCT * pooled["accepted"] and ok * 10 < 9 * n,
        "a global threshold hits 99% overall yet auto-accepts effective_date at under 90%",
    )


if __name__ == "__main__":
    main()
