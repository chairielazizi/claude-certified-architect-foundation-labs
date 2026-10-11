"""Offline stand-in for Claude in the D1.5 demos.

It is model-driven: it reads the request, the system prompt and the tool results to pick
its next action. Two behaviours matter for the lab:

* It follows a refund limit written in the system prompt *most* of the time. With
  probability VIOLATION_RATE (decided by `compliance_draw`) it refunds anyway, which is
  how prompt-only compliance fails in production: rarely, unpredictably, never zero.
* When a tool result tells it to escalate (the hook's deny reason), it does.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from shop_server import mcp_name, short_name  # noqa: E402

# Share of over-limit requests where the prompt-only model ignores the rule. Real rates
# vary by model, prompt and conversation length; the point is that they are not zero.
VIOLATION_RATE = 0.06


def _result_text(result: Any) -> str:
    content = result.get("content", "")
    return content if isinstance(content, str) else "".join(b.get("text", "") for b in content)


def _all_results(params: dict[str, Any]) -> list[Any]:
    """Every tool_result so far, oldest first (the model sees the whole conversation)."""
    found: list[Any] = []
    for msg in params["messages"]:
        if msg["role"] == "user" and not isinstance(msg["content"], str):
            found += [b for b in msg["content"] if b.get("type") == "tool_result"]
    return found


def _json_or_empty(result: Any) -> dict[str, Any]:
    try:
        value = json.loads(_result_text(result))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def make_support_model(compliance_draw: float = 1.0) -> lab.Responder:
    """compliance_draw in [0, 1): below VIOLATION_RATE the model ignores a prompt-stated limit."""

    def respond(params: dict[str, Any]) -> lab.Obj:
        request = params["messages"][0]["content"]
        system = lab.system_text(params)
        called = [short_name(n) for n in lab.all_tool_calls(params)]
        results = _all_results(params)
        last = results[-1] if results else None
        last_text = _result_text(last) if last else ""

        order_id = re.search(r"ORD-\d+", request).group(0)  # type: ignore[union-attr]
        stated = re.search(r"\$(\d+(?:\.\d+)?)", request)

        # 1) No amount in the request: look the order up (legacy IDs are ORD-1xxx).
        if stated is None and not any(c.startswith("get_order") for c in called):
            lookup = "get_order_legacy" if order_id.startswith("ORD-1") else "get_order_v2"
            return lab.message(lab.text("Let me look up the order first."), lab.tool_use(mcp_name(lookup), {"order_id": order_id}))

        if stated is not None:
            amount = float(stated.group(1))
        else:
            # Relies on the canonical fields the PostToolUse hook guarantees ("total" in dollars).
            orders = [p for p in map(_json_or_empty, results) if p.get("record_type") == "order"]
            amount = float(orders[0].get("total", 0)) if orders else 0.0

        escalate = lab.tool_use(
            mcp_name("escalate_to_human"),
            {"order_id": order_id, "amount": amount, "summary": f"Customer requests ${amount:.2f} refund for {order_id} (damaged item)."},
        )

        # 2) A denial that names the alternative workflow: follow it.
        if last and last.get("is_error") and "escalate_to_human" in last_text and "escalate_to_human" not in called:
            return lab.message(lab.text("That refund needs human approval, so I'm escalating it."), escalate)

        # 3) First action on the refund itself.
        if "process_refund" not in called and "escalate_to_human" not in called:
            prompt_has_limit = "$500" in system
            if prompt_has_limit and amount > 500 and compliance_draw >= VIOLATION_RATE:
                return lab.message(lab.text("This is above my refund limit, so I'll escalate."), escalate)
            refund = lab.tool_use(
                mcp_name("process_refund"), {"order_id": order_id, "amount": amount, "reason": "damaged item"}
            )
            return lab.message(lab.text(f"Processing a ${amount:.2f} refund."), refund)

        # 4) Report the outcome.
        payload = _json_or_empty(last) if last else {}
        if "ticket_id" in payload:
            return lab.message(
                lab.text(f"I can't approve ${amount:.2f} myself, so I've escalated {order_id} to a human agent (ticket {payload['ticket_id']}).")
            )
        if "refund_id" in payload:
            return lab.message(lab.text(f"Refunded ${amount:.2f} for {order_id} (refund {payload['refund_id']})."))
        return lab.message(lab.text(f"I couldn't complete the refund for {order_id}: {last_text}"))

    return respond
