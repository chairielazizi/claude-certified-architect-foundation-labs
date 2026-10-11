"""Customer-support backend shared by the D1.1 demos.

Holds the tool definitions sent to Claude, the functions that execute them, and a
*scripted model* used in offline mode. The scripted model is deliberately
"model-driven": it looks at what is already in the conversation (which tools ran,
what they returned) to choose its next action, exactly like Claude does - it is not
a fixed sequence.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

SYSTEM_PROMPT = (
    "You are a customer support agent for an online electronics store. "
    "Use the tools to look up real data before answering; never guess order details. "
    "When you have what you need, answer the customer concisely."
)

CUSTOMERS = {
    "alice@example.com": {"customer_id": "C-1001", "name": "Alice Tan", "tier": "gold"},
}
ORDERS = {
    "ORD-5521": {
        "order_id": "ORD-5521",
        "customer_id": "C-1001",
        "status": "delivered",
        "delivered_on": "2026-10-02",
        "items": ["Wireless headphones"],
        "total": 89.90,
    },
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_customer",
        "description": (
            "Look up a customer account by email address. Returns customer_id, name and tier. "
            "Use this when the customer identifies themselves by email or when you need their "
            "customer_id. Does not return order information - use lookup_order for that."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"email": {"type": "string", "description": "Customer email, e.g. alice@example.com"}},
            "required": ["email"],
        },
    },
    {
        "name": "lookup_order",
        "description": (
            "Fetch a single order by its order ID (format ORD-#### ). Returns status, delivery date, "
            "items and total. Use this for any question about a specific order. Does not look up "
            "customers - use get_customer for account questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string", "description": "Order ID, e.g. ORD-5521"}},
            "required": ["order_id"],
        },
    },
]


def execute_tool(name: str, tool_input: dict[str, Any]) -> tuple[str, bool]:
    """Run a tool and return (json_content, is_error)."""
    if name == "get_customer":
        customer = CUSTOMERS.get(tool_input.get("email", "").lower())
        if customer is None:
            return json.dumps({"error": "No customer with that email"}), True
        return json.dumps(customer), False
    if name == "lookup_order":
        order = ORDERS.get(tool_input.get("order_id", "").upper())
        if order is None:
            return json.dumps({"error": "No order with that ID"}), True
        return json.dumps(order), False
    return json.dumps({"error": f"Unknown tool {name}"}), True


# ---------------------------------------------------------------------------
# Offline stand-in for Claude
# ---------------------------------------------------------------------------


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    """Decide the next turn from the conversation so far (model-driven, not a fixed script)."""
    first_request = params["messages"][0]["content"]
    called = lab.all_tool_calls(params)
    results = [json.loads(r["content"]) for r in lab.tool_results(params)]

    email = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", first_request)
    order_id = re.search(r"ORD-\d+", first_request)

    # The customer gave an email but no order number: identify them first.
    if email and "get_customer" not in called:
        return lab.message(
            lab.text("Let me pull up your account first."),
            lab.tool_use("get_customer", {"email": email.group(0)}),
        )
    # We know which order is meant (stated directly, or it is the customer's latest).
    if "lookup_order" not in called:
        target = order_id.group(0) if order_id else "ORD-5521"
        return lab.message(
            lab.text("Now I'll check the order."),
            lab.tool_use("lookup_order", {"order_id": target}),
        )
    order = results[-1]
    return lab.message(
        lab.text(
            f"Your order {order['order_id']} ({', '.join(order['items'])}) was delivered on "
            f"{order['delivered_on']}. Total charged: ${order['total']:.2f}."
        )
    )
