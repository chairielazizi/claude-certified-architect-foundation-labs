"""Agent-side recovery policy for MCP tool errors (D2.2).

A subagent calls tools through ``call_structured`` which reads the error envelope and
decides locally:

    transient + isRetryable -> wait (retryAfterSeconds or exponential backoff), retry the SAME call
    validation              -> fix the input if a deterministic fixer exists, else ask for input
    business                -> never retry; hand customerMessage to whoever talks to the customer
    permission              -> never retry; escalate to someone with the right access
    still failing           -> stop and propagate to the coordinator WITH partial results and
                               the list of attempts, so it can decide what to do next

With a generic "Operation failed" the agent cannot tell these apart. It can only guess:
``call_retry_all`` (recovers timeouts but wastes retries on permanent errors) or
``call_no_retry`` (wastes nothing but gives up on timeouts it could have survived).
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

MAX_ATTEMPTS = 3  # per tool call, including the first one
BASE_BACKOFF_S = 0.5
SLEEP_SCALE = 0.01  # the demo really waits, but only 1% of the backoff so it stays fast


def result_text(result: Any) -> str:
    return "".join(c.text for c in result.content if getattr(c, "type", "") == "text")


def parse_envelope(result: Any) -> dict[str, Any] | None:
    """The structured error body, or None if the server sent something unstructured."""
    try:
        body = json.loads(result_text(result))
    except json.JSONDecodeError:
        return None
    return body if isinstance(body, dict) and "errorCategory" in body else None


# Validation errors carry details (field, expected_format, received). Where a correction
# is deterministic, the subagent fixes the input itself; otherwise it asks, never guesses.
def fix_order_id(args: dict[str, Any], details: dict[str, Any]) -> dict[str, Any] | None:
    if details.get("field") != "order_id":
        return None
    digits = re.sub(r"\D", "", str(args.get("order_id", "")))
    return {**args, "order_id": f"ORD-{digits}"} if len(digits) == 4 else None


FIXERS: dict[str, Callable[[dict[str, Any], dict[str, Any]], dict[str, Any] | None]] = {
    "lookup_order": fix_order_id,
    "process_refund": fix_order_id,
}


@dataclass
class Outcome:
    tool: str
    status: str  # ok | recovered | input_fixed | business_rule | escalate | needs_input | unresolved
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    customer_message: str | None = None
    attempts: list[dict[str, Any]] = field(default_factory=list)

    @property
    def resolved(self) -> bool:
        # A business-rule refusal is a resolved outcome: we know the answer and how to explain it.
        return self.status in ("ok", "recovered", "input_fixed", "business_rule")


async def call_structured(server: Any, tool: str, args: dict[str, Any]) -> Outcome:
    attempts: list[dict[str, Any]] = []
    current = dict(args)
    transient_failures = 0
    while True:
        result = await server.call_tool(tool, current)
        if not result.is_error:
            attempts.append({"tool": tool, "args": current, "outcome": "ok"})
            status = "ok" if len(attempts) == 1 else ("input_fixed" if current != args else "recovered")
            return Outcome(tool, status, result=json.loads(result_text(result)), attempts=attempts)

        envelope = parse_envelope(result)
        if envelope is None:
            # Unstructured error from a server we don't control: don't guess, propagate.
            attempts.append({"tool": tool, "args": current, "outcome": "unstructured"})
            return Outcome(tool, "unresolved", error={"message": result_text(result)}, attempts=attempts)

        category = envelope["errorCategory"]
        attempt: dict[str, Any] = {"tool": tool, "args": current, "outcome": category}
        attempts.append(attempt)

        if category == "transient" and envelope.get("isRetryable"):
            transient_failures += 1
            if len(attempts) >= MAX_ATTEMPTS:
                return Outcome(tool, "unresolved", error=envelope, attempts=attempts)
            wait = max(envelope.get("retryAfterSeconds", 0), BASE_BACKOFF_S * 2 ** (transient_failures - 1))
            attempt["then"] = f"wait {wait}s and retry"
            await asyncio.sleep(wait * SLEEP_SCALE)
            continue

        if category == "validation":
            fixer = FIXERS.get(tool)
            fixed = fixer(current, envelope.get("details", {})) if fixer else None
            if fixed and fixed != current and len(attempts) < MAX_ATTEMPTS:
                attempt["then"] = f"call again with corrected input {fixed}"
                current = fixed
                continue
            return Outcome(tool, "needs_input", error=envelope, attempts=attempts)

        if category == "business":
            return Outcome(tool, "business_rule", error=envelope, customer_message=envelope.get("customerMessage"), attempts=attempts)

        if category == "permission":
            return Outcome(tool, "escalate", error=envelope, attempts=attempts)

        return Outcome(tool, "unresolved", error=envelope, attempts=attempts)


async def call_retry_all(server: Any, tool: str, args: dict[str, Any]) -> Outcome:
    """Blind policy for generic errors: every failure might be transient, so retry it."""
    attempts: list[dict[str, Any]] = []
    for n in range(1, MAX_ATTEMPTS + 1):
        result = await server.call_tool(tool, args)
        attempts.append({"tool": tool, "args": dict(args), "outcome": "error" if result.is_error else "ok"})
        if not result.is_error:
            return Outcome(tool, "ok" if n == 1 else "recovered", result=json.loads(result_text(result)), attempts=attempts)
        if n < MAX_ATTEMPTS:
            await asyncio.sleep(BASE_BACKOFF_S * 2 ** (n - 1) * SLEEP_SCALE)
    return Outcome(tool, "unresolved", error={"message": result_text(result)}, attempts=attempts)


async def call_no_retry(server: Any, tool: str, args: dict[str, Any]) -> Outcome:
    """Blind policy for generic errors: every failure might be permanent, so give up."""
    result = await server.call_tool(tool, args)
    attempts = [{"tool": tool, "args": dict(args), "outcome": "error" if result.is_error else "ok"}]
    if result.is_error:
        return Outcome(tool, "unresolved", error={"message": result_text(result)}, attempts=attempts)
    return Outcome(tool, "ok", result=json.loads(result_text(result)), attempts=attempts)


Policy = Callable[[Any, str, dict[str, Any]], Awaitable[Outcome]]
POLICIES: dict[str, Policy] = {"structured": call_structured, "retry_all": call_retry_all, "no_retry": call_no_retry}


async def run_subtask(server: Any, steps: list[tuple[str, dict[str, Any]]], policy: Policy) -> dict[str, Any]:
    """Run a subagent's tool steps. Recover locally; propagate only what it cannot resolve."""
    report: dict[str, Any] = {"status": "complete", "results": [], "attempts": []}
    for index, (tool, args) in enumerate(steps):
        outcome = await policy(server, tool, args)
        report["attempts"] += outcome.attempts
        if outcome.resolved:
            entry: dict[str, Any] = {"tool": tool, "status": outcome.status, "result": outcome.result}
            if outcome.customer_message:
                entry["customerMessage"] = outcome.customer_message
            report["results"].append(entry)
            continue
        # Could not resolve locally: tell the coordinator what worked, what failed, what was tried.
        report["status"] = "partial" if report["results"] else "failed"
        report["unresolved"] = {"tool": tool, "args": args, "status": outcome.status, "error": outcome.error}
        report["not_attempted"] = [name for name, _ in steps[index + 1 :]]
        break
    return report


def wasted_retries(log: list[dict[str, Any]]) -> int:
    """Repeats of an identical call whose previous attempt failed for a NON-transient reason.

    Uses the backend's ground-truth log, so it is fair to both error styles.
    """
    wasted = 0
    for prev, cur in zip(log, log[1:]):
        same_call = cur["tool"] == prev["tool"] and cur["args"] == prev["args"]
        if same_call and prev["outcome"] not in ("transient", "ok"):
            wasted += 1
    return wasted
