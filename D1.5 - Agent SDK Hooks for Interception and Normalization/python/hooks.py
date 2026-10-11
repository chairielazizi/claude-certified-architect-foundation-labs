"""The two Agent SDK hooks this lab is about.

    PostToolUse  matcher "^mcp__shop__get_"
        Rewrites every shop lookup result into ONE canonical shape (ISO 8601 UTC dates,
        a string status enum, dollars) via hookSpecificOutput.updatedToolOutput, BEFORE
        the model sees it. The model never has to guess what status 3 or 10/06/2026 means.

    PreToolUse   matcher "mcp__shop__process_refund"
        Denies refunds above $500 with permissionDecision "deny" and a reason that tells
        the agent what to do instead (escalate_to_human). This is code, so it holds on
        every call; a sentence in the system prompt only holds most of the time.

Hook callbacks are plain async functions, so they can be unit-tested by calling them with
the same input_data dict the SDK would pass (see hook_demo.py).
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any

from claude_agent_sdk import HookContext, HookMatcher

REFUND_LIMIT_USD = 500.00

# The canonical status vocabulary every lookup is mapped onto. "unknown" is explicit so an
# unmapped backend value shows up as such instead of leaking through in its raw form.
STATUS_ENUM = ("pending", "processing", "shipped", "in_transit", "delivered", "cancelled", "refunded", "unknown")
LEGACY_STATUS_CODES = {0: "pending", 1: "processing", 2: "shipped", 3: "delivered", 4: "cancelled", 5: "refunded"}
SHIPMENT_STATES = {
    "label created": "processing",
    "in transit": "in_transit",
    "out for delivery": "in_transit",
    "delivered": "delivered",
    "returned": "cancelled",
}

# Audit trail of hook decisions. Demos print it; the live run checks it.
HOOK_EVENTS: list[dict[str, Any]] = []


# ---------------------------------------------------------------------------
# Format converters (one per source format, all producing ISO 8601 UTC "...Z")
# ---------------------------------------------------------------------------


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def from_epoch(seconds: float) -> str:
    return _iso_z(datetime.fromtimestamp(seconds, tz=timezone.utc))


def from_iso(value: str) -> str:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:  # no offset given: the v2 API contract says UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return _iso_z(dt)


def from_us_date(value: str) -> str:
    # The source is known to be MM/DD/YYYY, so 10/06/2026 is 6 October. Date-only values
    # become UTC midnight. Deciding this in code removes a guess the model would otherwise make.
    return _iso_z(datetime.strptime(value, "%m/%d/%Y").replace(tzinfo=timezone.utc))


def _status(value: str) -> str:
    return value if value in STATUS_ENUM else "unknown"


def normalize_legacy_order(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_type": "order",
        "order_id": raw["ord_no"],
        "customer_id": raw["cust"],
        "source_system": "legacy",
        "status": LEGACY_STATUS_CODES.get(raw["status"], "unknown"),
        "created_at": from_epoch(raw["created"]),
        "updated_at": from_epoch(raw["last_update"]),
        "total": raw["total_cents"] / 100,
        "currency": raw["currency"],
    }


def normalize_v2_order(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_type": "order",
        "order_id": raw["orderId"],
        "customer_id": raw["customerId"],
        "source_system": "v2",
        "status": _status(raw["status"].lower()),
        "created_at": from_iso(raw["createdAt"]),
        "updated_at": from_iso(raw["updatedAt"]),
        "total": raw["total"]["amount"],
        "currency": raw["total"]["currency"],
    }


def normalize_shipment(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_type": "shipment",
        "order_id": raw["order"],
        "source_system": "carrier",
        "status": SHIPMENT_STATES.get(raw["state"].lower(), "unknown"),
        "shipped_at": from_us_date(raw["ship_date"]),
        "estimated_delivery_at": from_us_date(raw["est_delivery"]),
        "carrier": raw["carrier"],
        "tracking_number": raw["tracking_no"],
    }


NORMALIZERS = {
    "get_order_legacy": normalize_legacy_order,
    "get_order_v2": normalize_v2_order,
    "get_shipment": normalize_shipment,
}


# ---------------------------------------------------------------------------
# tool_response plumbing
# ---------------------------------------------------------------------------


def _payload_text(tool_response: Any) -> str | None:
    """Text of an MCP tool result. Accepts the shapes the CLI may hand a hook: a list of
    content blocks, a dict with "content", or a plain string."""
    if isinstance(tool_response, str):
        return tool_response
    blocks = tool_response.get("content") if isinstance(tool_response, dict) else tool_response
    if not isinstance(blocks, list):
        return None
    texts = [b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"]
    return "".join(texts) if texts else None


def _wrap_like(original: Any, text: str) -> Any:
    """Return the replacement in the same shape the tool output arrived in."""
    block = {"type": "text", "text": text}
    if isinstance(original, str):
        return text
    if isinstance(original, dict):
        return {**original, "content": [block]}
    return [block]


# ---------------------------------------------------------------------------
# The hooks
# ---------------------------------------------------------------------------


async def normalize_shop_output(
    input_data: dict[str, Any], tool_use_id: str | None, context: HookContext
) -> dict[str, Any]:
    """PostToolUse: replace a raw shop lookup with the canonical record."""
    short = input_data["tool_name"].removeprefix("mcp__shop__")
    normalizer = NORMALIZERS.get(short)
    text = _payload_text(input_data.get("tool_response"))
    try:
        payload = json.loads(text) if text is not None else None
    except json.JSONDecodeError:
        payload = None
    if normalizer is None or not isinstance(payload, dict) or "error" in payload:
        return {}  # not a lookup we know, or an error result: pass it through untouched

    canonical = normalizer(payload)
    HOOK_EVENTS.append({"hook": "PostToolUse", "tool": short, "action": "normalized"})
    return {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "updatedToolOutput": _wrap_like(input_data.get("tool_response"), json.dumps(canonical)),
        }
    }


def _deny(reason: str, tool_input: dict[str, Any]) -> dict[str, Any]:
    HOOK_EVENTS.append({"hook": "PreToolUse", "tool": "process_refund", "action": "deny", "input": tool_input})
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def _parse_amount(raw: Any) -> float:
    if isinstance(raw, bool):
        return math.nan
    try:
        return float(raw)
    except (TypeError, ValueError):
        return math.nan


async def enforce_refund_limit(
    input_data: dict[str, Any], tool_use_id: str | None, context: HookContext
) -> dict[str, Any]:
    """PreToolUse: block refunds above the limit and redirect to escalate_to_human."""
    # The matcher scoped this hook to process_refund by NAME; the rule itself inspects the arguments.
    tool_input = input_data.get("tool_input") or {}
    amount = _parse_amount(tool_input.get("amount"))

    if not math.isfinite(amount) or amount < 0:
        # Fail closed: an amount we cannot read is never auto-approved.
        return _deny(
            f"process_refund needs a non-negative numeric amount, got {tool_input.get('amount')!r}. "
            "Ask the customer to confirm the amount or call escalate_to_human.",
            tool_input,
        )
    if amount > REFUND_LIMIT_USD:
        return _deny(
            f"Refund of ${amount:.2f} exceeds the ${REFUND_LIMIT_USD:.2f} limit for automatic refunds. "
            "This limit is enforced in code, so retrying process_refund will be denied again. "
            "Call escalate_to_human with the order_id, the amount and a one-line summary so a human "
            "agent can approve it, then tell the customer it has been escalated.",
            tool_input,
        )

    HOOK_EVENTS.append({"hook": "PreToolUse", "tool": "process_refund", "action": "allow", "input": tool_input})
    # {} = no opinion: the normal permission flow (allowed_tools) decides, so the hook only
    # ever takes permissions away and never grants more than the configuration does.
    return {}


# Matchers match the tool NAME (Claude Code treats a pattern with regex characters as a regex).
HOOKS: dict[str, list[HookMatcher]] = {
    "PreToolUse": [HookMatcher(matcher="mcp__shop__process_refund", hooks=[enforce_refund_limit])],
    "PostToolUse": [HookMatcher(matcher="^mcp__shop__get_", hooks=[normalize_shop_output])],
}
