"""D4.5 - Synchronous API or Message Batches? Match the API to the workflow's latency needs.

    someone is waiting (pre-merge check)          -> synchronous
    needs tool calls executed mid-task            -> synchronous (a batch request is one shot)
    latency-tolerant (overnight, weekly, nightly) -> Message Batches: 50% cost, up to 24h, no SLA

Also shows WHY multi-turn tool use does not fit a batch: the request just ends on tool_use.

Run:  python api_choice.py      (always offline: the batch part uses the simulated service)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from batch_workload import build_request, extraction_model, make_documents  # noqa: E402
from fake_batch_service import FakeBatchService, SimClock  # noqa: E402

BATCH_MAX_HOURS = 24

WORKFLOWS: list[dict[str, Any]] = [
    {"name": "pre-merge check", "blocking": True, "deadline_hours": 0.25, "needs_tool_loop": False},
    {"name": "overnight tech-debt report", "blocking": False, "deadline_hours": 12, "needs_tool_loop": False},
    {"name": "weekly compliance audit", "blocking": False, "deadline_hours": 72, "needs_tool_loop": False},
    {"name": "nightly test generation", "blocking": False, "deadline_hours": 10, "needs_tool_loop": False},
    {"name": "ticket triage agent (calls lookup tools)", "blocking": False, "deadline_hours": 24, "needs_tool_loop": True},
]


def choose_api(workflow: dict[str, Any]) -> tuple[str, str]:
    if workflow["blocking"]:
        return "sync", "a developer is waiting; batches have no latency SLA (up to 24h)"
    if workflow["needs_tool_loop"]:
        return "sync", "batch requests cannot execute tools mid-request and continue"
    note = "50% cheaper"
    if workflow["deadline_hours"] < BATCH_MAX_HOURS:
        note += "; usually done in < 1h, but a hard deadline under 24h is not guaranteed"
    return "batch", note


def main() -> None:
    lab.banner("D4.5  Choosing synchronous vs Message Batches")

    lab.section("1. choose_api() per workflow")
    choices = {}
    for w in WORKFLOWS:
        api, why = choose_api(w)
        choices[w["name"]] = api
        print(f"  {w['name']:<42} -> {api:<5}  ({why})")

    lab.section("2. Sample question 11: switch BOTH workflows to batch for the 50% saving?")
    verdicts = {
        "A. batch for tech-debt reports only; real-time for pre-merge": "correct - matches each API to its latency need",
        "B. both to batch, with status polling": "wrong - polling does not make a 24h-max job safe to block a merge on",
        "C. keep both real-time to avoid result ordering issues": "wrong - custom_id correlates results in any order",
        "D. both to batch with a real-time fallback on timeout": "wrong - extra complexity for the simple answer A",
    }
    for option, verdict in verdicts.items():
        print(f"  {option:<62} {verdict}")

    lab.section("3. Why a tool-calling workflow does not fit a batch")
    clock = SimClock()
    service = FakeBatchService(extraction_model, clock, seed=11)
    doc = make_documents(1)[0]
    request = build_request("triage-001", doc["text"], system="Look up the supplier's risk rating before answering.")
    request["params"]["tools"] = [
        {
            "name": "lookup_supplier_risk",
            "description": "Risk rating for a supplier",
            "input_schema": {"type": "object", "properties": {"supplier": {"type": "string"}}, "required": ["supplier"]},
        }
    ]
    batch = service.create(requests=[request])
    while service.retrieve(batch.id).processing_status != "ended":
        clock.advance(0.5)
    result = service.results(batch.id)[0]
    message = result.result.message
    print(f"  batch {batch.id} ended; {result.custom_id}: stop_reason={message.stop_reason!r}, tool call={lab.tool_uses(message)[0].name}")
    print("  The request is finished. Running the tool and continuing needs a NEW request:")
    print("  another batch round trip (up to 24h each) per tool step, or the synchronous API.")

    lab.check(choices["pre-merge check"] == "sync", "blocking pre-merge check -> synchronous API")
    lab.check(
        all(choices[n] == "batch" for n in ("overnight tech-debt report", "weekly compliance audit", "nightly test generation")),
        "overnight report, weekly audit, nightly test generation -> Message Batches",
    )
    lab.check(choices["ticket triage agent (calls lookup tools)"] == "sync", "a multi-turn tool loop -> synchronous API")
    lab.check(
        result.result.type == "succeeded" and message.stop_reason == "tool_use",
        "a batched request that wants a tool simply ends on stop_reason 'tool_use' - nothing runs the tool",
    )


if __name__ == "__main__":
    main()
