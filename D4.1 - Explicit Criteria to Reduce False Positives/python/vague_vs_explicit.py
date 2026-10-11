"""D4.1 - The same diff reviewed with vague, "be conservative", and explicit-criteria prompts.

    vague          "check that comments are accurate"           -> style nits + wording nitpicks
    conservative   "+ only report high-confidence findings"     -> still noisy (model is confident)
    explicit       REPORT bug/security/... SKIP style/patterns  -> only real issues
                   + severity rubric with code examples         -> consistent severities

Run:  python vague_vs_explicit.py          (offline, scripted reviewer)
      python vague_vs_explicit.py --live   (real Claude API, same diff and prompts)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_criteria import (  # noqa: E402
    FINDINGS_SCHEMA,
    FIXTURES,
    ReviewOutput,
    build_conservative_prompt,
    build_explicit_prompt,
    build_vague_prompt,
)
from scripted_reviewer import OBSERVATIONS, scripted_reviewer  # noqa: E402

DIFF = (FIXTURES / "sample_diff.txt").read_text(encoding="utf-8")


def review(client: Any, system: str) -> ReviewOutput:
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=system,
        # Structured output keeps the comparison about WHICH findings are reported,
        # not about whether the JSON parses (that is D4.3's topic).
        output_config={"format": {"type": "json_schema", "schema": FINDINGS_SCHEMA}},
        messages=[{"role": "user", "content": f"Review this diff:\n<diff>\n{DIFF}\n</diff>"}],
    )
    return ReviewOutput.model_validate(json.loads(lab.text_of(response)))


def label_of(finding: Any) -> dict[str, Any] | None:
    """Match a finding to the audited observation on (about) the same line."""
    candidates = [o for o in OBSERVATIONS if abs(o["line"] - finding.line) <= 1]
    same_cat = [o for o in candidates if o["category"] == finding.category]
    return (same_cat or candidates or [None])[0]


def score(output: ReviewOutput) -> dict[str, Any]:
    matched = [(f, label_of(f)) for f in output.findings]
    tp = [f for f, o in matched if o and o["label"] == "true_positive"]
    real_total = sum(o["label"] == "true_positive" for o in OBSERVATIONS)
    severity_ok = [o is not None and f.severity == o["rubric_severity"] for f, o in matched]
    return {
        "reported": len(output.findings),
        "true_positives": len(tp),
        "precision": len(tp) / len(output.findings) if output.findings else 1.0,
        "recall": len(tp) / real_total,
        "categories": sorted({f.category for f in output.findings}),
        "severity_matches_rubric": all(severity_ok),
    }


def main() -> None:
    lab.banner("D4.1  Vague instructions vs explicit review criteria")
    variants = {
        "vague": build_vague_prompt(),
        "conservative": build_conservative_prompt(),
        "explicit": build_explicit_prompt(),
        "explicit, comment_accuracy off": build_explicit_prompt({"comment_accuracy": False}),
    }
    results: dict[str, dict[str, Any]] = {}
    for name, system in variants.items():
        lab.section(f"prompt: {name}")
        output = review(lab.get_client(scripted_reviewer), system)
        for f in output.findings:
            print(f"  line {f.line:>2}  {f.category:<17} {f.severity:<8} {f.issue[:70]}")
        results[name] = score(output)
        s = results[name]
        print(
            f"  -> {s['reported']} findings, precision {s['precision']:.0%}, recall {s['recall']:.0%}, "
            f"severities match rubric: {s['severity_matches_rubric']}"
        )

    lab.section("Comparison")
    print(f"  {'prompt':<32}{'findings':>9}{'precision':>11}{'recall':>8}")
    for name, s in results.items():
        print(f"  {name:<32}{s['reported']:>9}{s['precision']:>11.0%}{s['recall']:>8.0%}")

    if not lab.is_live():
        vague, cons, expl, off = (results[k] for k in variants)
        lab.check(vague["precision"] < 0.5 and "style" in vague["categories"], "vague prompt: style nits and wording nitpicks, precision < 50%")
        lab.check(
            cons["precision"] < 0.5 and "style" in cons["categories"],
            "'be conservative / high-confidence only' barely helps: the model is confident about nits",
        )
        lab.check(expl["precision"] == 1.0 and expl["recall"] == 1.0, "explicit criteria: every real issue, nothing else")
        lab.check(
            not {"style", "local_pattern"} & set(expl["categories"]),
            "SKIP categories (minor style, local patterns) are not reported",
        )
        lab.check(
            expl["severity_matches_rubric"] and not vague["severity_matches_rubric"],
            "the severity rubric with code examples gives consistent severities; vague prompt does not",
        )
        lab.check(
            "comment_accuracy" not in off["categories"] and off["precision"] == 1.0,
            "toggling comment_accuracy off removes that category only (recall drops, precision holds)",
        )


if __name__ == "__main__":
    main()
