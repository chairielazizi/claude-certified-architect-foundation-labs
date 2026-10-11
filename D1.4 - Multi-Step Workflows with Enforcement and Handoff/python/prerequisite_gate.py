"""D1.4 - A programmatic prerequisite gate vs prompt-only enforcement (sample question 1).

  A  The model tries process_refund with the name the customer typed. The gate in the
     tool-execution layer blocks it with a structured error naming the missing prerequisite
     (get_customer). The model verifies, looks the order up, and the refund goes through.
  B  100 synthetic runs. A prompt-guided model skips verification about 12% of the time
     (deterministic seeded PRNG, the rate from sample Q1). Prompt-only: every skip becomes an
     unverified refund credited via a name match. Gate: 0 violations, and every run still completes.

Run:  python prerequisite_gate.py          (offline)
      python prerequisite_gate.py --live   (scenario A against the real API; B is always offline)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_tools import SYSTEM_PROMPT, ToolLayer, make_support_model, owner_of, run_agent  # noqa: E402

REQUEST = "Hi, I'm Jordan Lee (jordan@example.com). My order ORD-1001 arrived damaged - please refund the $129.00."
RUNS = 100
SKIP_RATE = 0.12  # sample question 1: "in 12% of cases, your agent skips get_customer entirely"
SEED = 20261011


def minstd(seed: int) -> Callable[[], float]:
    """Park-Miller 'minimal standard' PRNG: tiny, seedable, and identical in Python and TypeScript."""
    state = seed

    def next_float() -> float:
        nonlocal state
        state = state * 48271 % 2147483647
        return state / 2147483647

    return next_float


def simulate(enforce: bool, skips: list[bool]) -> dict[str, int]:
    """Run the same 100 model behaviours through either tool layer and count what went wrong."""
    totals = {"runs": 0, "skipped_verification": 0, "blocked_calls": 0, "unverified_refunds": 0,
              "misdirected_refunds": 0, "completed_refunds": 0}
    for skip in skips:
        tools = ToolLayer(enforce=enforce)
        run_agent(lab.ScriptedClient(make_support_model(skip_verification=skip)), REQUEST, tools, verbose=False)
        totals["runs"] += 1
        totals["skipped_verification"] += skip
        totals["blocked_calls"] += sum(c["outcome"] == "blocked" for c in tools.calls)
        totals["unverified_refunds"] += sum(not r["verified_at_time"] for r in tools.refunds)
        totals["misdirected_refunds"] += sum(r["credited_customer_id"] != owner_of(r["reference_id"]) for r in tools.refunds)
        totals["completed_refunds"] += len(tools.refunds)
    return totals


def main() -> None:
    lab.banner("D1.4  Programmatic prerequisite gate vs prompt-only enforcement")
    print(f"system prompt: {SYSTEM_PROMPT}")

    lab.section("A - the gate blocks a refund attempted before verification")
    print(f"user: {REQUEST}")
    tools = ToolLayer(enforce=True)
    answer, messages = run_agent(lab.get_client(make_support_model(skip_verification=True)), REQUEST, tools)
    print(f"assistant: {answer}")
    sequence = [f"{c['tool']}:{c['outcome']}" for c in tools.calls]
    print(f"tool calls: {sequence}")

    lab.check(all(r["verified_at_time"] and r["credited_customer_id"] == owner_of(r["reference_id"]) for r in tools.refunds),
              "every refund that ran had a verified customer and went to the order's owner")
    if not lab.is_live():
        blocked = next(b for m in messages if m["role"] == "user" and isinstance(m["content"], list)
                       for b in m["content"] if b.get("is_error"))
        error = json.loads(blocked["content"])
        lab.check(sequence[0] == "process_refund:blocked", "the first call, process_refund with the typed name, was blocked")
        lab.check(blocked["is_error"] and error["missing_prerequisite"] == "get_customer",
                  "the blocked call came back as an is_error tool_result naming the missing prerequisite")
        lab.check(sequence[1:] == ["get_customer:ok", "lookup_order:ok", "process_refund:ok"],
                  "the model recovered: verified, looked up the order, then the refund succeeded")

    lab.section(f"B - {RUNS} synthetic runs: prompt-only vs gate")
    rng = minstd(SEED)
    skips = [rng() < SKIP_RATE for _ in range(RUNS)]  # same behaviours for both modes
    prompt_only = simulate(enforce=False, skips=skips)
    gated = simulate(enforce=True, skips=skips)
    print(f"  {'mode':<12} {'runs':>4} {'skipped':>8} {'blocked':>8} {'unverified':>11} {'misdirected':>12} {'completed':>10}")
    for label, t in (("prompt-only", prompt_only), ("gate", gated)):
        print(f"  {label:<12} {t['runs']:>4} {t['skipped_verification']:>8} {t['blocked_calls']:>8} "
              f"{t['unverified_refunds']:>11} {t['misdirected_refunds']:>12} {t['completed_refunds']:>10}")
    print("  (unverified = refund ran before get_customer succeeded; misdirected = credited to the other 'Jordan Lee')")

    lab.check(prompt_only["skipped_verification"] == 12, "the seeded model skipped verification in 12 of 100 runs (~12%)")
    lab.check(prompt_only["unverified_refunds"] == 12 and prompt_only["misdirected_refunds"] == 12,
              "prompt-only: all 12 skips became unverified refunds credited to the wrong account")
    lab.check(gated["unverified_refunds"] == 0 and gated["misdirected_refunds"] == 0, "gate: 0 violations")
    lab.check(gated["blocked_calls"] == 12 and gated["completed_refunds"] == RUNS,
              "gate: the 12 bad attempts were blocked and all 100 customers still got their refund")


if __name__ == "__main__":
    main()
