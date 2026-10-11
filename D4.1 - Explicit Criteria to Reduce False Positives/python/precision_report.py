"""D4.1 - Measure precision per category, see the trust damage, toggle the noisy category off.

    labelled findings -> precision per category -> one noisy category drags down the rest
                      -> developers start ignoring REAL bugs too
                      -> disable that category (toggle) while its criteria get rewritten

Pure analysis over fixtures/historical_findings.json; no model calls.

Run:  python precision_report.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_criteria import (  # noqa: E402
    DEFAULT_TOGGLES,
    build_explicit_prompt,
    categories_to_disable,
    load_json,
    overall_precision,
    precision_by_category,
)


def ignored_true_positive_rate(findings: list[dict[str, Any]], weeks: set[int], categories: set[str]) -> float:
    """Share of REAL issues (audit label) that developers dismissed anyway."""
    real = [f for f in findings if f["week"] in weeks and f["category"] in categories and f["label"] == "true_positive"]
    return sum(f["developer_action"] == "dismissed" for f in real) / len(real) if real else 0.0


def main() -> None:
    lab.banner("D4.1  Precision per category and category toggles")
    findings = load_json("historical_findings.json")["findings"]

    lab.section("1. Precision per category (4 weeks, audited labels)")
    stats = precision_by_category(findings)
    print(f"  {'category':<18}{'reported':>9}{'true pos':>10}{'precision':>11}")
    for name, s in sorted(stats.items(), key=lambda kv: kv[1]["precision"]):
        print(f"  {name:<18}{s['reported']:>9}{s['true_positives']:>10}{s['precision']:>11.0%}")
    baseline = overall_precision(findings)
    print(f"  {'OVERALL':<18}{len(findings):>9}{sum(s['true_positives'] for s in stats.values()):>10}{baseline:>11.0%}")

    lab.check(stats["comment_accuracy"]["precision"] < 0.5, "comment_accuracy is mostly noise (precision below 50%)")
    lab.check(
        all(stats[c]["precision"] >= 0.6 for c in ("bug", "security", "performance")),
        "bug, security and performance findings are mostly right",
    )

    lab.section("2. The trust cost: real issues get ignored too")
    accurate = {c for c, s in stats.items() if s["precision"] >= 0.6}
    early = ignored_true_positive_rate(findings, {1, 2}, accurate)
    late = ignored_true_positive_rate(findings, {3, 4}, accurate)
    print(f"  real bug/security/performance findings dismissed, weeks 1-2: {early:.0%}")
    print(f"  real bug/security/performance findings dismissed, weeks 3-4: {late:.0%}")
    print("  -> after weeks of wording nitpicks, developers dismiss findings without reading them.")
    lab.check(late > early, "false positives in one category eroded trust in the ACCURATE categories")

    lab.section("3. Toggle the high-false-positive category off")
    noisy = categories_to_disable(stats, min_precision=0.6, min_samples=5)
    toggles = {**DEFAULT_TOGGLES, **{c: False for c in noisy}}
    lab.show("categories to disable", noisy)
    lab.show("toggles", toggles)
    kept = {c for c, on in toggles.items() if on}
    projected = overall_precision(findings, include=kept)
    print(f"  overall precision: {baseline:.0%} -> {projected:.0%} with {noisy} disabled")
    recall_cost = sum(1 for f in findings if f["category"] in noisy and f["label"] == "true_positive")
    print(f"  cost: {recall_cost} real comment contradictions will go unreported until the category returns")
    lab.check(noisy == ["comment_accuracy"], "only the category with enough data AND low precision is disabled")
    lab.check(projected > baseline + 0.15, "disabling it raises overall precision substantially")

    lab.section("4. The generated prompt reflects the toggles")
    prompt = build_explicit_prompt(toggles)
    print(prompt)
    report_block = prompt.split("REPORT only these categories:", 1)[1].split("\n\n", 1)[0]
    lab.check("comment_accuracy" not in report_block, "comment_accuracy is no longer in the REPORT list")
    lab.check(
        "- comment_accuracy: temporarily disabled" in prompt,
        "it is listed under SKIP as temporarily disabled, so the model actively skips it",
    )


if __name__ == "__main__":
    main()
