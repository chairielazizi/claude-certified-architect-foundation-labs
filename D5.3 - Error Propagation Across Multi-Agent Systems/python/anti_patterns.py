"""D5.3 - Error propagation anti-patterns side by side (sample question 8).

The same six-subtopic research run with four subagent designs. The coordinator's recovery
policy and the synthesis step are identical in every run; only what the subagent reports
changes:

    structured   envelope with failure_type, attempted_query, partial_results, alternatives  (Q8 A)
    generic      retries internally, then returns only "search unavailable"                  (Q8 B)
    suppress     catches the failure and returns an empty result marked success             (Q8 C)
    terminate    lets the exception reach a top-level handler that stops the workflow       (Q8 D)

This file always runs offline: it compares architectures, not model output.

Run:  python anti_patterns.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from research_system import (  # noqa: E402
    PLAN,
    RECOVERY_ACTIONS,
    TRANSIENT,
    SearchFailed,
    Subagent,
    decide_recovery,
    generic_subagent,
    raising_subagent,
    structured_subagent,
    suppressing_subagent,
    synthesize,
)

FAILURE_TYPES = (*TRANSIENT, "access_denied", "not_found")
# Ground truth from the simulation: which subtopics really hit a source failure on the first try.
ACTUALLY_FAILED = [p["subtopic"] for p in PLAN if structured_subagent(p["subtopic"], p["source"], p["query"])["status"] != "success"]


def run_pipeline(subagent: Subagent) -> tuple[str, list[dict[str, Any]], int] | None:
    """Fan out, one recovery round driven by decide_recovery, then synthesize."""
    history: dict[str, list[dict[str, Any]]] = {}
    try:
        for p in PLAN:
            history[p["subtopic"]] = [subagent(p["subtopic"], p["source"], p["query"])]
    except SearchFailed as exc:  # the top-level handler: the whole workflow ends here
        print(f"  workflow terminated: {exc}")
        return None
    recoveries = 0
    for p in PLAN:
        envs = history[p["subtopic"]]
        decision = decide_recovery(envs[-1], p, recovered_already=False)
        if decision["action"] in RECOVERY_ACTIONS:
            recoveries += 1
            envs.append(subagent(p["subtopic"], decision["source"], decision["query"]))
    report, rows = synthesize(history)
    return report, rows, recoveries


def quality(rows: list[dict[str, Any]], recoveries: int) -> dict[str, Any]:
    gaps = [r for r in rows if r["status"].startswith("gap")]
    return {
        "findings": sum(r["findings"] for r in rows),
        "subtopics with findings": sum(1 for r in rows if r["findings"]),
        "recovery attempts": recoveries,
        "successful recoveries": sum(1 for r in rows if "recovered via" in r["note"]),
        "false 'no data' claims": sum(1 for r in rows if r["status"] == "no published data" and r["subtopic"] in ACTUALLY_FAILED),
        "gaps disclosed": len(gaps),
        "gaps with failure detail": sum(1 for r in gaps if any(ft in r["note"] for ft in FAILURE_TYPES)),
    }


def main() -> None:
    lab.banner("D5.3  Error propagation anti-patterns (always offline)")
    print(f"subtopics whose first source really failed: {ACTUALLY_FAILED}")
    variants: dict[str, Subagent] = {
        "structured": structured_subagent,
        "generic": generic_subagent,
        "suppress": suppressing_subagent,
        "terminate": raising_subagent,
    }
    scores: dict[str, dict[str, Any] | None] = {}
    for name, subagent in variants.items():
        lab.section(f"{name} subagent")
        outcome = run_pipeline(subagent)
        if outcome is None:
            scores[name] = None
            print("  no report produced: the findings already gathered were thrown away with the run")
            continue
        report, rows, recoveries = outcome
        print("\n".join(report.split("## Coverage\n\n", 1)[1].split("\n")))
        scores[name] = quality(rows, recoveries)

    lab.section("Final report quality")
    metrics = list(next(s for s in scores.values() if s is not None))
    print(f"  {'':28}" + "".join(f"{n:>12}" for n in variants))
    for m in metrics:
        cells = "".join(f"{('-' if s is None else s[m])!s:>12}" for s in scores.values())
        print(f"  {m:28}{cells}")
    print(f"  {'report produced':28}" + "".join(f"{'no' if s is None else 'yes':>12}" for s in scores.values()))

    good, generic, suppress = scores["structured"], scores["generic"], scores["suppress"]
    assert good is not None and generic is not None and suppress is not None
    lab.section("Checks")
    lab.check(
        good["false 'no data' claims"] == 0 and good["gaps disclosed"] == good["gaps with failure detail"] == 1,
        "structured: no false claims; the one remaining gap is disclosed with its failure type",
    )
    lab.check(
        good["findings"] > max(generic["findings"], suppress["findings"]) and good["successful recoveries"] == 2,
        "structured: most findings, because the coordinator could pick the right recovery twice",
    )
    lab.check(
        suppress["false 'no data' claims"] == 3 and suppress["gaps disclosed"] == 0,
        "suppress: three failures became 'no published data' and the report claims full coverage",
    )
    lab.check(
        generic["successful recoveries"] == 0 and generic["gaps with failure detail"] == 0,
        "generic: blind retries of the same query failed again; no failure detail reached the report",
    )
    lab.check(generic["findings"] < good["findings"] - 4, "generic: the partial results were thrown away with the details")
    lab.check(scores["terminate"] is None, "terminate: one failure ended the whole workflow; nothing was delivered")


if __name__ == "__main__":
    main()
