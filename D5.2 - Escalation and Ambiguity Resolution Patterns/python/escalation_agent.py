"""D5.2 - Explicit escalation criteria + few-shot examples vs "escalate complex cases".

Every labelled case in fixtures/cases.json runs through the same agent loop twice: once
with a vague system prompt and once with explicit criteria and few-shot examples (the
fix from sample question 3). Decisions are read from the tools the agent actually called
(escalate_to_human / a resolution tool / neither), never from its wording.

Run:  python escalation_agent.py          (offline, scripted model)
      python escalation_agent.py --live   (real API on the same cases)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_agent import BASELINE_PROMPT, CRITERIA_PROMPT, load_fixture, pct, run_conversation, scripted_model  # noqa: E402

CASES = load_fixture("cases.json")["cases"]
SHORT = {
    "lookup_order": "lookup",
    "lookup_customer": "lookup",
    "escalate_to_human": "escalate",
    "issue_replacement": "replace",
    "apply_price_adjustment": "adjust",
    "issue_refund": "refund",
    "-": "-",
}


def evaluate(system: str) -> list[dict[str, Any]]:
    rows = []
    for case in CASES:
        result = run_conversation(lab.get_client(scripted_model), system, [case["message"]], verbose=False)
        rows.append({
            "id": case["id"],
            "expected": case["expected"],
            "reason": case["reason"],
            "outcome": result["outcome"],
            "first_call": result["calls"][0] if result["calls"] else "-",
            "calls": result["calls"],
        })
    return rows


def metrics(rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    return {
        "correct": [r["id"] for r in rows if r["outcome"] == r["expected"]],
        # Sample question 3's two symptoms:
        "straightforward_escalated": [r["id"] for r in rows if r["expected"] == "resolve" and r["outcome"] == "escalate"],
        "policy_handled_alone": [r["id"] for r in rows if r["reason"] in ("policy_gap", "policy_exception") and r["outcome"] != "escalate"],
        # Explicit requests must be honoured before any investigation.
        "explicit_not_immediate": [r["id"] for r in rows if r["reason"] == "explicit_request" and r["first_call"] != "escalate_to_human"],
    }


def main() -> None:
    lab.banner("D5.2  Explicit escalation criteria with few-shot examples")
    baseline, criteria = evaluate(BASELINE_PROMPT), evaluate(CRITERIA_PROMPT)

    lab.section("Decisions per case (x = wrong; 1st = first tool called)")
    print(f"  {'case':5} {'expected':9} {'vague prompt':25} {'explicit criteria':25}")
    for case, b, c in zip(CASES, baseline, criteria):
        cells = []
        for r in (b, c):
            mark = " " if r["outcome"] == r["expected"] else "x"
            cells.append(f"{mark} {r['outcome']:8} 1st={SHORT[r['first_call']]:9}")
        print(f"  {case['id']:5} {case['expected']:9} {cells[0]:25} {cells[1]:25} {case['message'][:40]}")

    lab.section("Scorecard")
    mb, mc = metrics(baseline), metrics(criteria)
    n = len(CASES)
    for key, label in [
        ("correct", "correct decisions"),
        ("straightforward_escalated", "straightforward cases escalated"),
        ("policy_handled_alone", "policy gaps/exceptions handled without a human"),
        ("explicit_not_immediate", "explicit human requests not honoured first"),
    ]:
        extra_b = f" ({pct(len(mb[key]), n)})" if key == "correct" else ""
        extra_c = f" ({pct(len(mc[key]), n)})" if key == "correct" else ""
        print(f"  {label:48} vague: {len(mb[key]):>2}{extra_b:9}  criteria: {len(mc[key]):>2}{extra_c}")
    print(f"  vague prompt mistakes: {sorted(set(r['id'] for r in baseline) - set(mb['correct']))}")

    lab.section("Checks")
    if lab.is_live():
        print("  live run: decisions above come from the real model; offline checks skipped")
        return
    lab.check(len(mc["correct"]) == n, "explicit criteria: every case got the expected decision")
    lab.check(
        len(mb["straightforward_escalated"]) >= 3 and len(mb["policy_handled_alone"]) >= 3,
        "vague prompt: escalated covered damage cases AND improvised policy exceptions (sample Q3's logs)",
    )
    lab.check(not mc["explicit_not_immediate"], "explicit criteria: human requests escalated before any lookup")
    lab.check(len(mb["explicit_not_immediate"]) == 2, "vague prompt: investigated first, then escalated the human requests")
    replacement_cases = [r["id"] for r in criteria if "issue_replacement" in r["calls"]]
    lab.check(replacement_cases == ["C02", "C05", "C11"], "explicit criteria: damage + photo resolved autonomously, even when the customer was furious (C05)")


if __name__ == "__main__":
    main()
