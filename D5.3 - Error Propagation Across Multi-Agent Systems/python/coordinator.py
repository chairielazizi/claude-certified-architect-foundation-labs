"""D5.3 - Structured error propagation lets the coordinator recover intelligently.

The coordinator (a Claude agent with delegate_search / submit_coverage tools) fans out six
research subtopics in one turn. Each search subagent recovers locally from transient
failures and returns a structured envelope for anything it cannot resolve. The coordinator
reads the envelopes and picks a recovery per failure:

    film      timeout on a broad query, 3 local attempts, 1 partial result -> retry with a NARROWER query
    writing   access_denied (not retried locally)                          -> try the ALTERNATIVE source
    games     rate_limited, source says "retry in 900 s" (> 300 s budget)  -> PROCEED with partial, annotate
    music     one timeout, recovered inside the subagent                   -> coordinator just sees success
    architecture  search worked, zero matches                              -> valid empty result, no retry

Synthesis then reports findings with coverage annotations.

Run:  python coordinator.py          (offline, scripted coordinator)
      python coordinator.py --live   (real model as coordinator; sources stay simulated)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from research_system import (  # noqa: E402
    COORDINATOR_PROMPT,
    COORDINATOR_TOOLS,
    PLAN,
    TOPIC,
    scripted_coordinator,
    structured_subagent,
    synthesize,
)

SAFETY_MAX_ITERATIONS = 10


def run_coordinator(client: Any) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": f"Research topic: {TOPIC}\nSubtopics and starting sources:\n{json.dumps(PLAN, indent=2)}"}
    ]
    history: dict[str, list[dict[str, Any]]] = {}
    turns: list[list[dict[str, Any]]] = []
    decisions: list[dict[str, Any]] = []
    for _ in range(SAFETY_MAX_ITERATIONS):
        response = client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=COORDINATOR_PROMPT, tools=COORDINATOR_TOOLS, messages=list(messages)
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return {"history": history, "turns": turns, "decisions": decisions, "final": lab.text_of(response)}
        results, batch = [], []
        for block in lab.tool_uses(response):
            args = dict(block.input)
            if block.name == "delegate_search":
                env = structured_subagent(args["subtopic"], args["source"], args["query"])
                history.setdefault(env["subtopic"], []).append(env)
                batch.append(env)
                result = {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(env)}
                if env["status"] == "failed":
                    result["is_error"] = True  # nothing usable came back; the envelope still explains why
            else:  # submit_coverage
                decisions = list(args["decisions"])
                result = {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps({"recorded": len(decisions)})}
            results.append(result)
        if batch:
            turns.append(batch)
        messages.append({"role": "user", "content": results})  # all results for the turn in ONE message
    raise RuntimeError("coordinator did not finish")


def main() -> None:
    lab.banner("D5.3  Structured error context drives coordinator recovery")
    run = run_coordinator(lab.get_client(scripted_coordinator))

    for i, batch in enumerate(run["turns"], 1):
        lab.section(f"Coordinator turn {i}: {len(batch)} delegation(s)")
        for env in batch:
            outcomes = [f"{a['outcome']}" + (f"(+{a['backoff_ms']}ms)" if a["backoff_ms"] else "") for a in env["attempts"]]
            print(f"  {env['subtopic']:12} {env['source']:16} {env['status']:8} {env['failure_type'] or '-':13} attempts: {' '.join(outcomes)}")
            if env["status"] != "success":
                print(f"      attempted_query='{env['attempted_query']}' partial={len(env['partial_results'])}")
                print(f"      alternatives={json.dumps(env['alternatives'])}")

    lab.section("Coverage decisions submitted by the coordinator")
    for d in run["decisions"]:
        print(f"  {d['subtopic']:12} {d['decision']:21} {d['note']}")

    lab.section("Synthesis with coverage annotations")
    report, rows = synthesize(run["history"])
    print(report)

    lab.section("Checks")
    # Subagent behaviour is deterministic (simulated sources), so these hold in live mode too.
    plan = {p["subtopic"]: p for p in PLAN}
    music = structured_subagent(**plan["music"])
    writing = structured_subagent(**plan["writing"])
    film = structured_subagent(**plan["film"])
    architecture = structured_subagent(**plan["architecture"])
    lab.check(
        music["status"] == "success" and [a["outcome"] for a in music["attempts"]] == ["timeout", "ok"],
        "music: the transient timeout was retried inside the subagent; the coordinator only sees a success",
    )
    lab.check(
        writing["failure_type"] == "access_denied" and len(writing["attempts"]) == 1 and writing["alternatives"],
        "writing: access_denied propagated at once (retrying cannot fix permissions), with alternatives",
    )
    lab.check(
        film["status"] == "partial" and [a["backoff_ms"] for a in film["attempts"]] == [200, 400, 0] and film["partial_results"],
        "film: unresolved timeout propagated with the attempted query, 3 backoff attempts and partial results",
    )
    lab.check(
        architecture["status"] == "success" and architecture["match_count"] == 0 and architecture["failure_type"] is None,
        "architecture: zero matches is a SUCCESS (valid empty result), not an access failure",
    )
    if lab.is_live():
        return
    recovery = sorted((e["subtopic"], e["source"], e["attempted_query"]) for e in run["turns"][1])
    lab.check(
        recovery == [("film", "web_search", "AI visual effects film production"), ("writing", "industry_reports", plan["writing"]["query"])],
        "coordinator: narrowed the film query and switched the writing source, both from envelope alternatives",
    )
    lab.check(len(run["history"]["architecture"]) == 1, "coordinator: did not retry the valid empty result")
    status = {r["subtopic"]: r["status"] for r in rows}
    lab.check(
        status["games"] == "gap: partial results" and status["architecture"] == "no published data" and len(rows) == len(PLAN),
        "synthesis: every subtopic has a coverage row; the gap and the genuine 'no data' are labelled differently",
    )
    lab.check(
        [status[s] for s in ("visual_arts", "music", "writing", "film")] == ["well-supported"] * 4,
        "synthesis: recovered subtopics are well-supported; only games is a gap",
    )


if __name__ == "__main__":
    main()
