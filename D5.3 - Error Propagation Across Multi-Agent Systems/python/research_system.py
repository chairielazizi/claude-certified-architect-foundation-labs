"""Research system shared by the D5.3 demos: search subagents, recovery policy, synthesis.

A search subagent returns a structured result envelope:

    status            success | partial | failed
    failure_type      timeout | rate_limited | access_denied | not_found | None
    retryable         whether the failure type is transient
    attempted_query   exactly what was tried, and where (source)
    attempts          [{attempt, outcome, backoff_ms}] - local recovery that already happened
    results           findings (a success with zero results is a VALID empty result)
    partial_results   whatever was gathered before the failure
    alternatives      recovery options the subagent can see (narrower query, other source, retry later)

Transient failures (timeout, rate_limited) are retried locally with exponential backoff;
only what the subagent cannot resolve is propagated. Access failures are not retried
locally because retrying cannot help, so they go straight to the coordinator.

The other subagent variants are the anti-patterns from sample question 8.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "research_sources.json").read_text(encoding="utf-8"))
TOPIC: str = FIXTURE["topic"]
PLAN: list[dict[str, str]] = FIXTURE["plan"]

TRANSIENT = ("timeout", "rate_limited")
MAX_ATTEMPTS = 3
BASE_BACKOFF_MS = 200
RETRY_BUDGET_S = 300  # the coordinator will not wait longer than this for a source


class SearchFailed(Exception):
    """Raised by the 'propagate the exception' anti-pattern."""


def _behaviour(source: str, query: str) -> dict[str, Any]:
    return FIXTURE["behaviour"].get(f"{source}|{query}", {"attempts": ["ok"], "results": []})


def _attempt_outcome(behaviour: dict[str, Any], attempt: int) -> str:
    outcomes = behaviour["attempts"]
    return outcomes[min(attempt, len(outcomes)) - 1]


# ---------------------------------------------------------------------------
# Subagents
# ---------------------------------------------------------------------------


def structured_subagent(subtopic: str, source: str, query: str) -> dict[str, Any]:
    """Correct: recover locally from transient failures, propagate the rest WITH context."""
    behaviour = _behaviour(source, query)
    attempts: list[dict[str, Any]] = []
    outcome = "ok"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        outcome = _attempt_outcome(behaviour, attempt)
        retry = outcome in TRANSIENT and attempt < MAX_ATTEMPTS
        # A real subagent sleeps for backoff_ms here; the lab only records it.
        attempts.append({"attempt": attempt, "outcome": outcome, "backoff_ms": BASE_BACKOFF_MS * 2 ** (attempt - 1) if retry else 0})
        if outcome == "ok" or not retry:
            break  # success, or a failure that retrying cannot fix (access_denied, not_found)
    envelope: dict[str, Any] = {"subtopic": subtopic, "source": source, "attempted_query": query, "attempts": attempts}
    if outcome == "ok":
        results = behaviour.get("results", [])
        return {**envelope, "status": "success", "failure_type": None, "retryable": False, "results": results,
                "match_count": len(results), "partial_results": [], "alternatives": []}
    partial = behaviour.get("partial", [])
    return {**envelope, "status": "partial" if partial else "failed", "failure_type": outcome,
            "retryable": outcome in TRANSIENT, "results": [], "partial_results": partial,
            "alternatives": behaviour.get("alternatives", [])}


def suppressing_subagent(subtopic: str, source: str, query: str) -> dict[str, Any]:
    """ANTI-PATTERN (Q8 option C): catch the failure and return an empty result marked success."""
    envelope = structured_subagent(subtopic, source, query)
    if envelope["status"] != "success":
        return {"subtopic": subtopic, "source": source, "status": "success", "results": []}
    return {"subtopic": subtopic, "source": source, "status": "success", "results": envelope["results"]}


def generic_subagent(subtopic: str, source: str, query: str) -> dict[str, Any]:
    """ANTI-PATTERN (Q8 option B): retry internally, then report only 'search unavailable'."""
    envelope = structured_subagent(subtopic, source, query)
    if envelope["status"] != "success":
        return {"subtopic": subtopic, "status": "error", "message": "search unavailable"}
    return {"subtopic": subtopic, "source": source, "status": "success", "results": envelope["results"]}


def raising_subagent(subtopic: str, source: str, query: str) -> dict[str, Any]:
    """ANTI-PATTERN (Q8 option D): let the failure escape to a top-level handler."""
    envelope = structured_subagent(subtopic, source, query)
    if envelope["status"] != "success":
        raise SearchFailed(f"{source} failed for {subtopic}")
    return envelope


Subagent = Callable[[str, str, str], dict[str, Any]]

# ---------------------------------------------------------------------------
# Coordinator recovery policy (uses only what the envelope tells it)
# ---------------------------------------------------------------------------

RECOVERY_ACTIONS = ("narrow_query", "alternative_source", "retry_same")


def decide_recovery(env: dict[str, Any], request: dict[str, str], recovered_already: bool) -> dict[str, Any]:
    if env.get("status") == "success":
        why = f"{len(env.get('results', []))} result(s)" if env.get("results") else "valid empty result: the search worked, nothing exists"
        return {"action": "accept", "reason": why}
    partial = bool(env.get("partial_results"))
    if recovered_already:  # one recovery per subtopic keeps the run bounded
        return {"action": "proceed_with_partial" if partial else "record_gap", "reason": "recovery already attempted"}
    if "failure_type" not in env:
        # Generic status: no failure type, no query, no alternatives. All it can do is retry blindly.
        return {"action": "retry_same", "source": request["source"], "query": request["query"], "reason": "no detail; blind retry"}
    failure = env["failure_type"]
    alternatives = env.get("alternatives", [])

    def option(action: str) -> dict[str, Any] | None:
        return next((a for a in alternatives if a["action"] == action), None)

    narrow, other_source, later = option("narrow_query"), option("alternative_source"), option("retry_later")
    if failure == "timeout" and narrow:
        return {"action": "narrow_query", "source": env["source"], "query": narrow["query"], "reason": "broad query timed out"}
    if failure in ("access_denied", "not_found") and other_source:
        return {"action": "alternative_source", "source": other_source["source"], "query": env["attempted_query"], "reason": f"{failure} on {env['source']}"}
    if later and later["after_seconds"] <= RETRY_BUDGET_S:
        return {"action": "retry_same", "source": env["source"], "query": env["attempted_query"], "reason": "source asked us to wait briefly"}
    if other_source:
        return {"action": "alternative_source", "source": other_source["source"], "query": env["attempted_query"], "reason": failure}
    return {
        "action": "proceed_with_partial" if partial else "record_gap",
        "reason": f"{failure}; no recovery fits the {RETRY_BUDGET_S}s budget",
    }


def coverage_decision(envs: list[dict[str, Any]]) -> str:
    final = envs[-1]
    if final.get("status") == "success":
        if not final.get("results"):
            return "no_data"
        return "recovered" if len(envs) > 1 else "accept"
    return "proceed_with_partial" if final.get("partial_results") else "gap"


# ---------------------------------------------------------------------------
# Synthesis with coverage annotations
# ---------------------------------------------------------------------------


def coverage_status(final: dict[str, Any]) -> str:
    status = final.get("status")
    if status == "success":
        n = len(final.get("results", []))
        return "well-supported" if n >= 2 else "limited: 1 source" if n == 1 else "no published data"
    if status == "partial":
        return "gap: partial results"
    if status == "failed":
        return "gap: source unavailable"
    return "gap: unknown error"


def coverage_note(envs: list[dict[str, Any]]) -> str:
    parts = []
    for i, env in enumerate(envs):
        attempts = env.get("attempts", [])
        failed = [a["outcome"] for a in attempts if a["outcome"] != "ok"]
        if env.get("status") == "success":
            if failed:
                parts.append(f"{env['source']} recovered locally after {len(failed)}x {failed[0]}")
            if i > 0:
                parts.append(f"recovered via {env['source']} '{env['attempted_query']}'")
            if "match_count" in env and env["match_count"] == 0:
                parts.append(f"{env['source']} search succeeded with 0 matches")
        elif "failure_type" in env:
            parts.append(f"{env['source']} {env['failure_type']} after {len(attempts)} attempt(s)")
            if i == len(envs) - 1 and env.get("partial_results"):
                parts.append(f"proceeding with {len(env['partial_results'])} partial result(s)")
        else:
            parts.append(env.get("message", "error"))
    return "; ".join(parts)


def title(subtopic: str) -> str:
    text = subtopic.replace("_", " ")
    return text[:1].upper() + text[1:].lower()


def synthesize(history: dict[str, list[dict[str, Any]]]) -> tuple[str, list[dict[str, Any]]]:
    """Render the report and return its coverage rows."""
    sections: list[str] = []
    rows: list[dict[str, Any]] = []
    for subtopic, envs in history.items():
        final = envs[-1]
        findings = final.get("results") or final.get("partial_results") or []
        status = coverage_status(final)
        rows.append({"subtopic": subtopic, "status": status, "sources": len(findings), "note": coverage_note(envs), "findings": len(findings)})
        sections.append(f"### {title(subtopic)} ({status})")
        sections += [f"- {r['finding']} [{r['title']}, {r['date']}]" for r in findings]
        if status == "no published data":
            sections.append(f"- The {final.get('source', 'source')} search succeeded and found no published data on this.")
        elif not findings:
            sections.append("- No findings: see the coverage table.")
        sections.append("")
    table = ["| subtopic | coverage | sources | note |", "|---|---|---|---|"]
    table += [f"| {r['subtopic']} | {r['status']} | {r['sources']} | {r['note']} |" for r in rows]
    report = f"# {TOPIC}\n\n## Findings\n\n" + "\n".join(sections) + "\n## Coverage\n\n" + "\n".join(table)
    return report, rows


# ---------------------------------------------------------------------------
# The coordinator as a Claude agent (delegate_search + submit_coverage tools)
# ---------------------------------------------------------------------------

COORDINATOR_PROMPT = (
    f"You coordinate research on '{TOPIC}'. Delegate each subtopic with delegate_search; you may send "
    "several delegate_search calls in one turn. Each result is a structured envelope with status "
    "(success | partial | failed), failure_type, attempted_query, attempts, results, partial_results and "
    "alternatives. Rules: a success with zero results is a valid finding (nothing exists); do not retry it. "
    "On failure, choose a recovery from the envelope: narrow the query after a timeout, use an alternative "
    "source after access_denied, and proceed with the partial results (annotating the gap) when no recovery "
    f"fits a {RETRY_BUDGET_S}-second budget. At most one recovery per subtopic. When every subtopic is "
    "settled, call submit_coverage with one decision per subtopic."
)

COORDINATOR_TOOLS: list[dict[str, Any]] = [
    {
        "name": "delegate_search",
        "description": "Run a search subagent for one subtopic on one source. Returns a structured result envelope.",
        "input_schema": {
            "type": "object",
            "properties": {
                "subtopic": {"type": "string"},
                "source": {"type": "string", "enum": ["web_search", "academic_db", "news_archive", "industry_reports"]},
                "query": {"type": "string"},
            },
            "required": ["subtopic", "source", "query"],
        },
    },
    {
        "name": "submit_coverage",
        "description": "Finish: record the coverage decision for every subtopic before synthesis.",
        "input_schema": {
            "type": "object",
            "properties": {
                "decisions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "subtopic": {"type": "string"},
                            "decision": {"type": "string", "enum": ["accept", "recovered", "proceed_with_partial", "no_data", "gap"]},
                            "note": {"type": "string"},
                        },
                        "required": ["subtopic", "decision", "note"],
                    },
                }
            },
            "required": ["decisions"],
        },
    },
]


def _get(block: Any, name: str) -> Any:
    return block.get(name) if isinstance(block, dict) else getattr(block, name, None)


def envelope_history(params: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, str]]]:
    """Every envelope (in order) per subtopic, plus the last request sent for each subtopic."""
    requests: dict[str, dict[str, str]] = {}
    history: dict[str, list[dict[str, Any]]] = {}
    for msg in params["messages"]:
        if isinstance(msg["content"], str):
            continue
        for block in msg["content"]:
            kind = _get(block, "type")
            if msg["role"] == "assistant" and kind == "tool_use" and _get(block, "name") == "delegate_search":
                request = dict(_get(block, "input"))
                requests[request["subtopic"]] = request
            if msg["role"] == "user" and kind == "tool_result":
                data = json.loads(_get(block, "content"))
                if "subtopic" in data:
                    history.setdefault(data["subtopic"], []).append(data)
    return history, requests


def scripted_coordinator(params: dict[str, Any]) -> lab.Obj:
    called = lab.all_tool_calls(params)
    if not called:  # fan out: one assistant turn, six delegations
        return lab.message(lab.text("Delegating all six subtopics in parallel."), *[lab.tool_use("delegate_search", dict(item)) for item in PLAN])
    if "submit_coverage" in called:
        return lab.message(lab.text("Coverage submitted; handing over to synthesis."))
    history, requests = envelope_history(params)
    recoveries = []
    for subtopic, envs in history.items():
        decision = decide_recovery(envs[-1], requests[subtopic], recovered_already=len(envs) > 1)
        if decision["action"] in RECOVERY_ACTIONS:
            recoveries.append(lab.tool_use("delegate_search", {"subtopic": subtopic, "source": decision["source"], "query": decision["query"]}))
    if recoveries:
        return lab.message(lab.text(f"Recovering {len(recoveries)} subtopic(s) using the envelopes' alternatives."), *recoveries)
    decisions = [{"subtopic": s, "decision": coverage_decision(envs), "note": coverage_note(envs) or "first attempt succeeded"} for s, envs in history.items()]
    return lab.message(lab.tool_use("submit_coverage", {"decisions": decisions}))
