"""D4.4 - Feedback loop: detected_pattern on every finding makes dismissals analysable.

    reviewer emits {category, detected_pattern, message}
    developers accept / dismiss
    dismissal rate per detected_pattern -> the exact construct that produces false positives
    (per category the signal is diluted: "bug" mixes great patterns with noisy ones)

Pure analysis over fixtures/review_history.json (simulated developer feedback); no model calls.

Run:  python dismissal_analysis.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

# The reviewer's output tool: detected_pattern is a first-class, required field.
REPORT_FINDING_TOOL: dict[str, Any] = {
    "name": "report_finding",
    "description": "Report one review finding.",
    "input_schema": {
        "type": "object",
        "properties": {
            "file": {"type": "string"},
            "category": {"type": "string", "enum": ["bug", "security", "performance", "style"]},
            "detected_pattern": {
                "type": "string",
                "description": "kebab-case name of the code construct that triggered the finding, e.g. "
                "'broad-except-reraise', 'sql-string-format'. Reuse an existing name when the construct is the same.",
            },
            "message": {"type": "string"},
        },
        "required": ["file", "category", "detected_pattern", "message"],
    },
}


class ReviewFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    file: str
    category: Literal["bug", "security", "performance", "style"]
    detected_pattern: str = Field(pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    message: str
    developer_action: Literal["accepted", "dismissed"]


def dismissal_rates(findings: list[ReviewFinding], key: str) -> dict[str, dict[str, Any]]:
    rates: dict[str, dict[str, Any]] = {}
    for f in findings:
        r = rates.setdefault(getattr(f, key), {"n": 0, "dismissed": 0})
        r["n"] += 1
        r["dismissed"] += f.developer_action == "dismissed"
    for r in rates.values():
        r["rate"] = r["dismissed"] / r["n"]
    return dict(sorted(rates.items(), key=lambda kv: -kv[1]["rate"]))


def flag(rates: dict[str, dict[str, Any]], min_samples: int = 5, threshold: float = 0.7) -> list[str]:
    """Enough evidence AND mostly dismissed. Small samples are watched, not acted on."""
    return [k for k, r in rates.items() if r["n"] >= min_samples and r["rate"] >= threshold]


def print_rates(title: str, rates: dict[str, dict[str, Any]], flagged: list[str]) -> None:
    print(f"  {title:<24}{'n':>4}{'dismissed':>11}{'rate':>7}")
    for k, r in rates.items():
        mark = "  <- false-positive source" if k in flagged else ""
        print(f"  {k:<24}{r['n']:>4}{r['dismissed']:>11}{r['rate']:>7.0%}{mark}")


def main() -> None:
    lab.banner("D4.4  Dismissal analysis by detected_pattern")
    raw = json.loads((FIXTURES / "review_history.json").read_text(encoding="utf-8"))["findings"]
    findings = [ReviewFinding.model_validate(f) for f in raw]
    lab.show("reviewer output schema: detected_pattern", REPORT_FINDING_TOOL["input_schema"]["properties"]["detected_pattern"])

    lab.section("1. Overall")
    overall = sum(f.developer_action == "dismissed" for f in findings) / len(findings)
    print(f"  {len(findings)} findings, {overall:.0%} dismissed. Something is noisy, but what?")

    lab.section("2. By category (what you get without detected_pattern)")
    by_category = dismissal_rates(findings, "category")
    category_flags = flag(by_category)
    print_rates("category", by_category, category_flags)

    lab.section("3. By detected_pattern")
    by_pattern = dismissal_rates(findings, "detected_pattern")
    pattern_flags = flag(by_pattern)
    print_rates("detected_pattern", by_pattern, pattern_flags)

    lab.section("4. What to change")
    fixes = {
        "broad-except-reraise": "add an explicit criterion + an acceptable-pattern example: logging and re-raising is NOT an issue (keep R-19's 'loses the cause' case)",
        "magic-number-in-test": "add a SKIP rule: literal values in tests/** are expected data, not magic numbers",
    }
    for p in pattern_flags:
        print(f"  {p}: {fixes.get(p, 'review the criterion that produces it')}")
    kept = [f for f in findings if f.detected_pattern not in pattern_flags]
    projected = sum(f.developer_action == "dismissed" for f in kept) / len(kept)
    print(f"  dismissal rate without those patterns: {overall:.0%} -> {projected:.0%}")

    lab.check(len(findings) == 36, "every finding validated with a detected_pattern field")
    lab.check(
        "bug" not in category_flags and 0.3 < by_category["bug"]["rate"] < 0.7,
        "per category, 'bug' looks merely mixed: the noisy construct is hidden inside it",
    )
    lab.check(set(pattern_flags) == {"broad-except-reraise", "magic-number-in-test"}, "per pattern, the two false-positive constructs stand out")
    lab.check(by_pattern["unbounded-retry-loop"]["rate"] == 0, "...while other 'bug' patterns are fully trusted and must be kept")
    lab.check("mutable-default-arg" not in pattern_flags, "a 3-sample pattern is not acted on (minimum sample size)")
    lab.check(projected < overall / 2, "fixing two criteria more than halves the dismissal rate")


if __name__ == "__main__":
    main()
