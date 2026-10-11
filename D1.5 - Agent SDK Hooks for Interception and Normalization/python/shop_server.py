"""In-process "shop" MCP server shared by the D1.5 demos.

Three backend systems that disagree about data formats (the situation the exam describes):

    get_order_legacy   Unix epoch seconds, numeric status codes (3 = delivered), cents
    get_order_v2       ISO 8601 with a local UTC offset, upper-case status strings
    get_shipment       US-style MM/DD/YYYY dates, free-text shipment state

plus two actions, process_refund and escalate_to_human.

The tools return raw backend data on purpose. Normalization and the refund limit are NOT
implemented here; they live in hooks.py, which is the point of the lab. The refund backend
has no limit at all (think of a legacy payments API), so the hook is the only guard.
"""

from __future__ import annotations

import json
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

SERVER_NAME = "shop"

# Legacy order system (pre-2026 migration): epoch seconds, numeric statuses, integer cents.
LEGACY_ORDERS: dict[str, dict[str, Any]] = {
    "ORD-1001": {
        "ord_no": "ORD-1001",
        "cust": "C-1001",
        "created": 1790932500,  # 2026-10-02T09:15:00Z
        "last_update": 1791304800,  # 2026-10-06T16:40:00Z
        "status": 3,  # 3 = delivered, but only the legacy team knows that
        "total_cents": 75000,
        "currency": "USD",
    },
}

# Current platform: ISO 8601 with the warehouse's local offset, upper-case statuses.
V2_ORDERS: dict[str, dict[str, Any]] = {
    "ORD-2002": {
        "orderId": "ORD-2002",
        "customerId": "C-2002",
        "createdAt": "2026-10-05T14:30:00+08:00",
        "updatedAt": "2026-10-06T09:00:00+08:00",
        "status": "SHIPPED",
        "total": {"amount": 129.99, "currency": "USD"},
    },
}

# Carrier integration: MM/DD/YYYY. "10/06/2026" is 6 October; a model guessing could read 10 June.
SHIPMENTS: dict[str, dict[str, Any]] = {
    "ORD-2002": {
        "order": "ORD-2002",
        "carrier": "UPS",
        "tracking_no": "1Z999AA10123456784",
        "ship_date": "10/06/2026",
        "est_delivery": "10/09/2026",
        "state": "In Transit",
    },
}

# Side-effect ledgers. Tools run in-process, so the demos (and live checks) can inspect them.
REFUNDS: list[dict[str, Any]] = []
ESCALATIONS: list[dict[str, Any]] = []


def reset_ledgers() -> None:
    REFUNDS.clear()
    ESCALATIONS.clear()


def _ok(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}


def _err(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps({"error": message})}], "is_error": True}


@tool(
    "get_order_legacy",
    "Look up an order in the LEGACY order system (orders placed before the 2026 migration, IDs ORD-1xxx). "
    "Returns the order's status, timestamps and total.",
    {"order_id": str},
)
async def get_order_legacy(args: dict[str, Any]) -> dict[str, Any]:
    order = LEGACY_ORDERS.get(str(args.get("order_id", "")).upper())
    return _ok(order) if order else _err("No legacy order with that ID")


@tool(
    "get_order_v2",
    "Look up an order on the current order platform (IDs ORD-2xxx). Returns status, timestamps and total.",
    {"order_id": str},
)
async def get_order_v2(args: dict[str, Any]) -> dict[str, Any]:
    order = V2_ORDERS.get(str(args.get("order_id", "")).upper())
    return _ok(order) if order else _err("No v2 order with that ID")


@tool(
    "get_shipment",
    "Get the carrier, tracking number, ship date and estimated delivery date for an order.",
    {"order_id": str},
)
async def get_shipment(args: dict[str, Any]) -> dict[str, Any]:
    shipment = SHIPMENTS.get(str(args.get("order_id", "")).upper())
    return _ok(shipment) if shipment else _err("No shipment for that order")


@tool(
    "process_refund",
    "Refund an amount in USD to the customer's original payment method for one order.",
    {"order_id": str, "amount": float, "reason": str},
)
async def process_refund(args: dict[str, Any]) -> dict[str, Any]:
    # No limit check here on purpose: the business rule is enforced by the PreToolUse hook.
    refund = {
        "refund_id": f"RF-{len(REFUNDS) + 1:04d}",
        "order_id": args.get("order_id"),
        "amount": float(args.get("amount", 0)),
        "status": "processed",
    }
    REFUNDS.append(refund)
    return _ok(refund)


@tool(
    "escalate_to_human",
    "Hand the case to a human support agent who can approve exceptions such as large refunds. "
    "Include the order ID, the amount involved and a one-line summary; the human cannot see this conversation.",
    {"order_id": str, "amount": float, "summary": str},
)
async def escalate_to_human(args: dict[str, Any]) -> dict[str, Any]:
    ticket = {
        "ticket_id": f"ESC-{len(ESCALATIONS) + 1:04d}",
        "order_id": args.get("order_id"),
        "amount": float(args.get("amount", 0)),
        "summary": args.get("summary", ""),
        "queue": "refund-approvals",
    }
    ESCALATIONS.append(ticket)
    return _ok(ticket)


SHOP_TOOLS = [get_order_legacy, get_order_v2, get_shipment, process_refund, escalate_to_human]
TOOLS_BY_NAME = {t.name: t for t in SHOP_TOOLS}

# The in-process MCP server handed to ClaudeAgentOptions(mcp_servers={"shop": SHOP_SERVER}).
SHOP_SERVER = create_sdk_mcp_server(name=SERVER_NAME, version="1.0.0", tools=SHOP_TOOLS)


def mcp_name(short: str) -> str:
    """The name the model (and hook matchers) see: mcp__<server>__<tool>."""
    return f"mcp__{SERVER_NAME}__{short}"


def short_name(full: str) -> str:
    return full.removeprefix(f"mcp__{SERVER_NAME}__")


ALLOWED_TOOLS = [mcp_name(t.name) for t in SHOP_TOOLS]

# The same tools as Messages-API definitions, used only by the offline agent loop in harness.py.
_JSON_TYPES = {str: "string", float: "number", int: "integer"}
API_TOOL_DEFS: list[dict[str, Any]] = [
    {
        "name": mcp_name(t.name),
        "description": t.description,
        "input_schema": {
            "type": "object",
            "properties": {k: {"type": _JSON_TYPES[v]} for k, v in t.input_schema.items()},  # type: ignore[union-attr]
            "required": list(t.input_schema),  # type: ignore[arg-type]
        },
    }
    for t in SHOP_TOOLS
]
