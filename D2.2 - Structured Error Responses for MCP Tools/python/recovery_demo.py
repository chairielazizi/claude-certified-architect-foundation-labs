"""D2.2 - Structured MCP errors vs "Operation failed": recovery decisions and wasted retries.

Six scenarios run against the REAL MCP server objects (in-process ``await
server.call_tool(...)`` returns genuine ``CallToolResult``s with ``is_error``):

  1. flaky backend: order service times out twice, then answers   -> transient
  2. refund of $900 (agent limit $500)                            -> business
  3. order id typed as "#1002"                                    -> validation
  4. KB search with no matches                                    -> SUCCESS, matched 0
  5. refund on a corporate account without the scope             -> permission
  6. multi-step task while the KB is down                         -> unresolved -> propagate

Each runs three ways: structured server + envelope-reading policy, and the generic server
with each blind policy available to it (retry everything / retry nothing).
Always offline (no model involved). Run:  python recovery_demo.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from recovery_policy import POLICIES, run_subtask, wasted_retries  # noqa: E402
from support_server import Backend, build_server  # noqa: E402

Setup = Callable[[Backend], None]

SCENARIOS: list[tuple[str, Setup, list[tuple[str, dict[str, Any]]]]] = [
    ("1 flaky order service", lambda b: b.lookup_timeouts.update({"ORD-1001": 2}), [("lookup_order", {"order_id": "ORD-1001"})]),
    ("2 refund over policy", lambda b: None, [("process_refund", {"order_id": "ORD-1001", "amount": 900.0})]),
    ("3 malformed order id", lambda b: None, [("lookup_order", {"order_id": "#1002"})]),
    ("4 search, no matches", lambda b: None, [("search_kb", {"query": "warp drive warranty"})]),
    ("5 corporate refund", lambda b: None, [("process_refund", {"order_id": "ORD-3003", "amount": 40.0})]),
    (
        "6 KB outage mid-task",
        lambda b: setattr(b, "kb_down", True),
        [("lookup_order", {"order_id": "ORD-1001"}), ("search_kb", {"query": "headphone return window"})],
    ),
]

# (server error style, agent policy)
STRATEGIES = {
    "structured": ("structured", "structured"),
    "generic+retry_all": ("generic", "retry_all"),
    "generic+no_retry": ("generic", "no_retry"),
}


async def run(setup: Setup, steps: list[tuple[str, dict[str, Any]]], strategy: str) -> tuple[dict[str, Any], Backend]:
    style, policy = STRATEGIES[strategy]
    backend = Backend()  # fresh state per run so every strategy sees the same failures
    setup(backend)
    server = build_server(backend, style)
    report = await run_subtask(server, steps, POLICIES[policy])
    return report, backend


def final_status(report: dict[str, Any]) -> str:
    if report["status"] == "complete":
        return report["results"][-1]["status"]
    return report["unresolved"]["status"]


async def main() -> None:
    lab.banner("D2.2  Structured MCP error responses and agent-side recovery")

    lab.section("What travels over MCP for a business-rule failure (wire shape)")
    probe = build_server(Backend(), "structured")
    wire = await probe.call_tool("process_refund", {"order_id": "ORD-1001", "amount": 900.0})
    print(json.dumps(wire.model_dump(by_alias=True, exclude_none=True, exclude={"result_type"}), indent=2))
    generic_wire = await build_server(Backend(), "generic").call_tool("process_refund", {"order_id": "ORD-1001", "amount": 900.0})
    print(f"generic variant: isError={generic_wire.is_error} text={generic_wire.content[0].text}")

    totals = {name: {"wasted": 0, "calls": 0} for name in STRATEGIES}
    table: list[tuple[str, dict[str, str]]] = []
    reports: dict[tuple[str, str], dict[str, Any]] = {}
    for title, setup, steps in SCENARIOS:
        lab.section(f"Scenario {title}")
        row: dict[str, str] = {}
        for strategy in STRATEGIES:
            report, backend = await run(setup, steps, strategy)
            reports[(title, strategy)] = report
            wasted = wasted_retries(backend.log)
            totals[strategy]["wasted"] += wasted
            totals[strategy]["calls"] += len(backend.log)
            row[strategy] = f"{final_status(report)} calls={len(backend.log)}"
            print(f"  {strategy:<18} -> {final_status(report):<13} calls={len(backend.log)} wasted_retries={wasted}")
            if strategy == "structured":
                for attempt in report["attempts"]:
                    print(f"      attempt {attempt['tool']}({attempt['args']}) -> {attempt['outcome']}  {attempt.get('then', '')}")
                for result in report["results"]:
                    if result.get("customerMessage"):
                        print(f"      customerMessage: {result['customerMessage']}")
        table.append((title, row))

    lab.section("Scenario 6: what the subagent propagates to the coordinator")
    report6 = reports[("6 KB outage mid-task", "structured")]
    lab.show(
        "structured report (attempts abridged)",
        {
            **report6,
            "results": [{"tool": r["tool"], "status": r["status"], "result": {"order_id": r["result"]["order_id"], "status": r["result"]["status"]}} for r in report6["results"]],
            "attempts": [f"{a['tool']} -> {a['outcome']}" for a in report6["attempts"]],
        },
    )
    generic6 = reports[("6 KB outage mid-task", "generic+retry_all")]
    print(f"generic variant propagates only: {generic6['unresolved']['error']}")
    print("  -> the coordinator cannot tell 'KB down, try later / use cached policy' from 'bad query'")

    lab.section("Summary")
    print(f"  {'scenario':<24}" + "".join(f"{s:<26}" for s in STRATEGIES))
    for title, row in table:
        print(f"  {title:<24}" + "".join(f"{row[s]:<26}" for s in STRATEGIES))
    print(f"  {'wasted retries':<24}" + "".join(f"{totals[s]['wasted']:<26}" for s in STRATEGIES))
    print(f"  {'total tool calls':<24}" + "".join(f"{totals[s]['calls']:<26}" for s in STRATEGIES))

    s = {title: reports[(title, "structured")] for title, _, _ in SCENARIOS}
    lab.section("Checks")
    lab.check(wire.is_error and json.loads(wire.content[0].text)["errorCategory"] == "business", "MCP result carries isError=true plus a categorised envelope")
    lab.check(final_status(s["1 flaky order service"]) == "recovered" and len(s["1 flaky order service"]["attempts"]) == 3,
              "transient timeouts recovered locally inside the subagent (2 retries, then success)")
    refund = s["2 refund over policy"]
    lab.check(len(refund["attempts"]) == 1 and "supervisor" in refund["results"][0]["customerMessage"],
              "business rule: not retried, customerMessage available to explain it")
    lab.check(final_status(s["3 malformed order id"]) == "input_fixed" and s["3 malformed order id"]["results"][0]["result"]["order_id"] == "ORD-1002",
              "validation: input corrected from details (#1002 -> ORD-1002) instead of retried as-is")
    empty = s["4 search, no matches"]["results"][0]
    lab.check(empty["status"] == "ok" and empty["result"]["matched"] == 0, "empty search is a successful query (matched 0), not an error")
    lab.check(final_status(s["5 corporate refund"]) == "escalate", "permission error escalated, not retried")
    six = s["6 KB outage mid-task"]
    lab.check(six["status"] == "partial" and six["results"][0]["tool"] == "lookup_order" and six["unresolved"]["error"]["errorCategory"] == "transient",
              "unresolvable outage propagated with partial results, attempts and the error category")
    lab.check(totals["structured"]["wasted"] == 0 < totals["generic+retry_all"]["wasted"],
              f"wasted retries: structured 0 vs generic+retry_all {totals['generic+retry_all']['wasted']}")
    lab.check(final_status(reports[("1 flaky order service", "generic+no_retry")]) == "unresolved",
              "generic+no_retry avoids waste but gives up on a timeout it could have survived")


if __name__ == "__main__":
    lab.run(main())
