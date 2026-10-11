"""D5.6 - Conflicting statistics are annotated, temporal differences are not conflicts.

The analysis step groups claims and classifies each group:

    established   one value (possibly from several sources)
    temporal      values differ but every value comes from a different data period
                  (4% for 2024, 9% for 2026-H1): a change over time, NOT a contradiction
    conflict      different values for the same period from credible sources
                  (USD 1.2 bn vs USD 0.8 bn for H1 2026): keep BOTH, annotated with sources

The analysis completes with conflicts annotated and unresolved; the coordinator (a model
call with a record_reconciliation tool) decides how to reconcile before synthesis.

Run:  python conflicts_and_temporal.py          (offline)
      python conflicts_and_temporal.py --live   (real model as coordinator)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from provenance import all_claims, analyze, periods, reconcile, scripted_model  # noqa: E402


def main() -> None:
    lab.banner("D5.6  Conflicts annotated, temporal differences recognised")
    claims = all_claims()
    analysis = analyze(claims)

    lab.section("Classification")
    for g in analysis["groups"]:
        detail = "; ".join(f"{v['value'] or '-'} ({', '.join(sorted(periods(v))) or 'n/a'})" for v in g["variants"])
        print(f"  {g['status']:12} {g['claim_key']:26} {detail}")

    lab.section("Annotated conflicts handed to the coordinator")
    before = json.loads(json.dumps(analysis["conflicts"]))  # snapshot: the analysis output as-is
    print(json.dumps(before, indent=2))

    lab.section("Coordinator reconciliation")
    decisions = reconcile(lab.get_client(scripted_model), analysis["conflicts"])
    for key, d in decisions.items():
        print(f"  {key}: {d['decision']} - {d['rationale']}")

    lab.section("Checks")
    status = {g["claim_key"]: g["status"] for g in analysis["groups"]}
    funding = next(c for c in before if c["claim_key"] == "ai_music_funding_2026h1")
    lab.check(
        [v["value"] for v in funding["values"]] == ["1.2", "0.8"] and [v["sources"] for v in funding["values"]] == [["S2"], ["S5"]],
        "the funding conflict keeps both values, each with its own source",
    )
    lab.check(all(c["status"] == "unresolved" for c in before), "the analysis step annotated the conflict instead of picking a value")
    lab.check(status["ai_track_streaming_share"] == "temporal", "4% (2024) vs 9% (2026-H1) is classified as a temporal difference")
    lab.check([k for k, s in status.items() if s == "conflict"] == ["ai_music_funding_2026h1"], "only the same-period disagreement is a conflict")
    lab.check(
        sum(len(v["citations"]) for g in analysis["groups"] for v in g["variants"]) == len(claims),
        "the analysis completed without dropping any claim",
    )
    if not lab.is_live():
        lab.check(
            decisions.get("ai_music_funding_2026h1", {}).get("decision") == "report_both_with_methodology",
            "the coordinator chose to report both values with their methodologies",
        )


if __name__ == "__main__":
    main()
