"""D1.4 support backend: tools, data, the handoff contract, and the tool-execution layer.

ToolLayer(enforce=True) is the programmatic prerequisite gate (sample question 1). It sits in
the tool-execution layer, where every tool call passes through it, regardless of what the model
decided:
  * lookup_order / lookup_invoice / process_refund are BLOCKED until get_customer has returned a
    verified customer_id in this session;
  * process_refund also needs that customer_id, the order/invoice looked up and owned by that
    customer, and an amount within the agent's refund limit.
Blocked calls return a structured is_error tool_result naming the missing prerequisite, so the
model can recover instead of failing.

ToolLayer(enforce=False) is prompt-only enforcement: the same tools, with the ordering rule
living only in the system prompt.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

SYSTEM_PROMPT = (
    "You are a customer support agent for an electronics store. Always verify the customer's identity "
    "with get_customer before looking up orders or invoices or processing refunds. Refunds above $500 "
    "need a human agent: escalate with a complete handoff summary."
)

AGENT_REFUND_LIMIT = 500.00
NEEDS_VERIFIED_CUSTOMER = {"lookup_order", "lookup_invoice", "process_refund"}

# Two customers share a name on purpose: a name typed in chat is not an identity.
# Dict order matters for the legacy name lookup below, which takes the FIRST match.
CUSTOMERS: dict[str, dict[str, Any]] = {
    "jordan.lee@example.net": {"customer_id": "C-3090", "name": "Jordan Lee", "tier": "standard"},
    "jordan@example.com": {"customer_id": "C-2001", "name": "Jordan Lee", "tier": "standard"},
    "sam@example.com": {"customer_id": "C-2002", "name": "Sam Rivera", "tier": "gold"},
}
ORDERS: dict[str, dict[str, Any]] = {
    "ORD-1001": {"order_id": "ORD-1001", "customer_id": "C-2001", "item": "Bluetooth speaker", "total": 129.00,
                 "status": "delivered", "delivered_on": "2026-10-03"},
    "ORD-2002": {"order_id": "ORD-2002", "customer_id": "C-2002", "item": "65-inch OLED TV", "total": 899.00,
                 "status": "delivered", "delivered_on": "2026-10-04"},
}
INVOICES: dict[str, dict[str, Any]] = {
    "INV-77": {
        "invoice_id": "INV-77", "customer_id": "C-2001", "description": "Premium membership, October",
        "charges": [
            {"charge_id": "CH-501", "amount": 49.99, "date": "2026-10-01"},
            {"charge_id": "CH-502", "amount": 49.99, "date": "2026-10-01"},
        ],
        "amount_due": 49.99,
    },
}


# ---------------------------------------------------------------------------
# Structured handoff: what a human agent needs when they cannot see the transcript
# ---------------------------------------------------------------------------


@dataclass
class HandoffSummary:
    customer_id: str  # the VERIFIED id, never a name
    issue_summary: str
    root_cause: str
    refund_amount: float
    actions_taken: list[str]
    recommended_action: str
    priority: str  # low | normal | high | urgent


HANDOFF_FIELDS = [f.name for f in fields(HandoffSummary)]
PRIORITIES = ("low", "normal", "high", "urgent")


def validate_handoff(summary: dict[str, Any]) -> list[str]:
    """Problems that would leave a human agent guessing (empty list = usable handoff)."""
    problems = [f"{name}: missing" for name in HANDOFF_FIELDS if summary.get(name) in (None, "", [])]
    customer_id = summary.get("customer_id")
    if isinstance(customer_id, str) and customer_id and not re.fullmatch(r"C-\d{4}", customer_id):
        problems.append("customer_id: must be a verified id like C-1234, not a name")
    amount = summary.get("refund_amount")
    if amount is not None and (isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0):
        problems.append("refund_amount: must be a non-negative number")
    actions = summary.get("actions_taken")
    if actions not in (None, []) and not (isinstance(actions, list) and all(isinstance(a, str) for a in actions)):
        problems.append("actions_taken: must be a list of strings")
    priority = summary.get("priority")
    if priority not in (None, "") and priority not in PRIORITIES:
        problems.append(f"priority: must be one of {list(PRIORITIES)}")
    return problems


def render_ticket(ticket_id: str, summary: dict[str, Any]) -> str:
    """The ticket exactly as the human queue shows it: the summary is ALL the human gets."""
    lines = [f"[{ticket_id}] priority={summary['priority'].upper()}  customer={summary['customer_id']}",
             f"Issue:       {summary['issue_summary']}",
             f"Root cause:  {summary['root_cause']}",
             f"Refund:      ${summary['refund_amount']:.2f}",
             "Actions taken:"]
    lines += [f"  - {a}" for a in summary["actions_taken"]]
    lines.append(f"Recommended: {summary['recommended_action']}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------


def _schema(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties)}


_S = {"type": "string"}
TOOLS: list[dict[str, Any]] = [
    {"name": "get_customer",
     "description": "Verify a customer's identity by email. Returns the verified customer_id. Required before any "
                    "order, invoice or refund operation; a name typed in chat is not a verified identity.",
     "input_schema": _schema({"email": {"type": "string", "description": "Customer email, e.g. jordan@example.com"}})},
    {"name": "lookup_order",
     "description": "Fetch one order (ORD-####): item, total, status, delivery date. Requires a verified customer.",
     "input_schema": _schema({"order_id": _S})},
    {"name": "lookup_invoice",
     "description": "Fetch one billing invoice (INV-##) with its individual charges. Use for billing disputes such as "
                    "double charges. Requires a verified customer.",
     "input_schema": _schema({"invoice_id": _S})},
    {"name": "process_refund",
     "description": f"Refund against an order or invoice that you have looked up. customer_id must be the verified id. "
                    f"Agents may refund up to ${AGENT_REFUND_LIMIT:.0f}; above that, use escalate_to_human.",
     "input_schema": _schema({"customer_id": _S, "reference_id": {"type": "string", "description": "ORD-#### or INV-##"},
                              "amount": {"type": "number"}, "reason": _S})},
    {"name": "escalate_to_human",
     "description": "Hand the case to a human agent who CANNOT see this conversation. Provide a complete, "
                    "self-contained summary: verified customer_id, issue, root cause, refund amount, actions already "
                    "taken, recommended action and priority.",
     "input_schema": _schema({
         "customer_id": _S, "issue_summary": _S, "root_cause": _S, "refund_amount": {"type": "number"},
         "actions_taken": {"type": "array", "items": _S}, "recommended_action": _S,
         "priority": {"type": "string", "enum": list(PRIORITIES)}})},
]


def resolve_customer(ref: Any) -> str | None:
    """Legacy CRM lookup used by the refund backend: accepts an id OR a name (first match wins)."""
    ref = str(ref or "")
    for customer in CUSTOMERS.values():
        if ref == customer["customer_id"] or ref.lower() == customer["name"].lower():
            return customer["customer_id"]
    return None


def refundable(record: dict[str, Any]) -> float:
    if "total" in record:
        return float(record["total"])
    billed = sum(c["amount"] for c in record["charges"])
    return round(billed - record["amount_due"], 2)


class ToolLayer:
    """Executes every tool call for the agent loop. enforce=True makes it the prerequisite gate."""

    def __init__(self, enforce: bool = True) -> None:
        self.enforce = enforce
        self.verified: dict[str, Any] | None = None  # set ONLY by a successful get_customer
        self.looked_up: dict[str, dict[str, Any]] = {}  # reference_id -> record seen this session
        self.calls: list[dict[str, Any]] = []  # audit log of every call and its outcome
        self.refunds: list[dict[str, Any]] = []
        self.escalations: list[dict[str, Any]] = []

    def execute(self, name: str, args: dict[str, Any]) -> tuple[str, bool]:
        """Run a tool; returns (json_content, is_error)."""
        blocked = (self.check_prerequisites(name, args) if self.enforce else None) or self.check_handoff(name, args)
        if blocked:
            self.calls.append({"tool": name, "input": args, "outcome": "blocked", "error": blocked["error"]})
            return json.dumps(blocked), True
        result, is_error = self._run(name, args)
        self.calls.append({"tool": name, "input": args, "outcome": "error" if is_error else "ok"})
        return json.dumps(result), is_error

    def check_prerequisites(self, name: str, args: dict[str, Any]) -> dict[str, Any] | None:
        """The gate. Returns a structured error naming what is missing, or None to allow."""
        if name in NEEDS_VERIFIED_CUSTOMER and self.verified is None:
            return {"error": "prerequisite_not_met", "blocked_tool": name, "missing_prerequisite": "get_customer",
                    "detail": "No verified customer in this session. Call get_customer with the customer's email "
                              "first; a name typed in chat is not an identity."}
        if name != "process_refund" or self.verified is None:
            return None
        verified_id = self.verified["customer_id"]
        if args.get("customer_id") != verified_id:
            return {"error": "prerequisite_not_met", "blocked_tool": name, "missing_prerequisite": "verified customer_id",
                    "detail": f"customer_id {args.get('customer_id')!r} is not the verified customer {verified_id}."}
        ref = str(args.get("reference_id", ""))
        record = self.looked_up.get(ref)
        if record is None:
            lookup = "lookup_invoice" if ref.startswith("INV-") else "lookup_order"
            return {"error": "prerequisite_not_met", "blocked_tool": name, "missing_prerequisite": lookup,
                    "detail": f"Look up {ref} before refunding against it."}
        if record["customer_id"] != verified_id:
            return {"error": "ownership_mismatch", "blocked_tool": name,
                    "detail": f"{ref} does not belong to verified customer {verified_id}."}
        amount = float(args.get("amount", 0))
        if amount > refundable(record):
            return {"error": "amount_exceeds_charge", "blocked_tool": name, "refundable": refundable(record), "requested": amount}
        if amount > AGENT_REFUND_LIMIT:
            return {"error": "refund_limit_exceeded", "blocked_tool": name, "limit": AGENT_REFUND_LIMIT, "requested": amount,
                    "required_next_step": "escalate_to_human with a complete handoff summary"}
        return None

    def check_handoff(self, name: str, args: dict[str, Any]) -> dict[str, Any] | None:
        """Handoff validation is data validation, so it applies in both modes."""
        if name != "escalate_to_human":
            return None
        problems = validate_handoff(args)
        if self.verified and args.get("customer_id") not in (None, "", self.verified["customer_id"]):
            problems.append("customer_id: does not match the verified customer")
        if not problems:
            return None
        return {"error": "invalid_handoff", "blocked_tool": name, "problems": problems,
                "detail": "The human agent cannot see this conversation; the summary must stand on its own."}

    def _run(self, name: str, args: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        if name == "get_customer":
            customer = CUSTOMERS.get(str(args.get("email", "")).lower())
            if customer is None:
                return {"error": "not_found", "detail": "No customer with that email"}, True
            self.verified = {**customer, "verified": True}
            return self.verified, False
        if name in ("lookup_order", "lookup_invoice"):
            table, key = (ORDERS, "order_id") if name == "lookup_order" else (INVOICES, "invoice_id")
            record = table.get(str(args.get(key, "")).upper())
            if record is None:
                return {"error": "not_found", "detail": f"No record {args.get(key)!r}"}, True
            self.looked_up[record[key]] = record
            return record, False
        if name == "process_refund":
            refund = {
                "refund_id": f"RF-{len(self.refunds) + 1:03d}",
                "reference_id": args.get("reference_id"),
                "amount": float(args.get("amount", 0)),
                "credited_customer_id": resolve_customer(args.get("customer_id")),
                "verified_at_time": self.verified is not None,
                "status": "processed",
            }
            self.refunds.append(refund)
            return refund, False
        if name == "escalate_to_human":
            ticket = {"ticket_id": f"HD-{4400 + len(self.escalations) + 1}", "queue": "tier2-refunds", "status": "queued"}
            self.escalations.append({**ticket, "summary": args})
            return ticket, False
        return {"error": f"unknown tool {name}"}, True


def owner_of(reference_id: str) -> str | None:
    record = ORDERS.get(reference_id) or INVOICES.get(reference_id)
    return record["customer_id"] if record else None


# ---------------------------------------------------------------------------
# The agent loop (same shape as D1.1) and helpers for scripted models
# ---------------------------------------------------------------------------

SAFETY_MAX_ITERATIONS = 15


def run_agent(client: Any, request: str, tools: ToolLayer, *, verbose: bool = True) -> tuple[str, list[dict[str, Any]]]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": request}]
    for _ in range(SAFETY_MAX_ITERATIONS):
        response = client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=SYSTEM_PROMPT, tools=TOOLS, messages=messages
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return lab.text_of(response), messages
        results = []
        for block in lab.tool_uses(response):
            content, is_error = tools.execute(block.name, block.input)
            if verbose:
                shown = f"is_error {content}" if is_error else content[:220]  # errors in full: they drive recovery
                print(f"  {block.name}({json.dumps(block.input)})\n     -> {shown}")
            result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
            if is_error:
                result["is_error"] = True
            results.append(result)
        messages.append({"role": "user", "content": results})
    raise RuntimeError(f"Agent did not finish in {SAFETY_MAX_ITERATIONS} iterations")


def tool_log(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Every tool call so far with its parsed result, in order (for model-driven scripted turns)."""
    calls: dict[str, tuple[str, dict[str, Any]]] = {}
    log: list[dict[str, Any]] = []
    for msg in params["messages"]:
        if isinstance(msg["content"], str):
            continue
        for block in msg["content"]:
            if block["type"] == "tool_use":
                calls[block["id"]] = (block["name"], block["input"])
            elif block["type"] == "tool_result":
                name, tool_input = calls[block["tool_use_id"]]
                log.append({"name": name, "input": tool_input, "result": json.loads(block["content"]),
                            "is_error": bool(block.get("is_error"))})
    return log


def tag(text: str, name: str) -> str:
    match = re.search(rf"<{name}>\s*(.*?)\s*</{name}>", text, re.S)
    return match.group(1) if match else ""


def make_support_model(skip_verification: bool = False) -> Callable[[dict[str, Any]], lab.Obj]:
    """Offline stand-in for Claude on refund requests; decides each turn from the conversation.

    skip_verification=True reproduces sample question 1's failure mode: despite the system prompt,
    the model acts on the name the customer typed instead of calling get_customer first.
    """

    def model(params: dict[str, Any]) -> lab.Obj:
        request = params["messages"][0]["content"]
        email = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", request).group(0)
        stated_name = re.search(r"I'm ([A-Z][a-z]+ [A-Z][a-z]+)", request).group(1)
        order_id = re.search(r"ORD-\d+", request).group(0)
        stated_amount = float(re.search(r"\$([\d,]+\.\d{2})", request).group(1).replace(",", ""))
        log = tool_log(params)
        last = log[-1] if log else None

        def succeeded(tool: str) -> dict[str, Any] | None:
            return next((e["result"] for e in log if e["name"] == tool and not e["is_error"]), None)

        customer, order = succeeded("get_customer"), succeeded("lookup_order")
        refund, ticket = succeeded("process_refund"), succeeded("escalate_to_human")

        if ticket:
            return lab.message(lab.text(
                f"I'm sorry about the {order['item']}. A refund of ${order['total']:.2f} needs approval from a senior "
                f"agent, so I've escalated it as ticket {ticket['ticket_id']} with everything they need. You won't "
                "have to repeat any of this."))
        if refund:
            return lab.message(lab.text(
                f"Done: I've refunded ${refund['amount']:.2f} for order {refund['reference_id']} (refund {refund['refund_id']})."))
        if last and last["is_error"] and last["result"].get("missing_prerequisite") == "get_customer":
            return lab.message(lab.text("I need to verify your account first."), lab.tool_use("get_customer", {"email": email}))
        if skip_verification and not log:
            # The failure mode: acts on the name typed in chat instead of verifying identity.
            return lab.message(lab.text("I'll get that refund started right away."), lab.tool_use("process_refund", {
                "customer_id": stated_name, "reference_id": order_id, "amount": stated_amount,
                "reason": "Item arrived damaged"}))
        if not customer:
            return lab.message(lab.text("Let me verify your account first."), lab.tool_use("get_customer", {"email": email}))
        if not order:
            return lab.message(lab.tool_use("lookup_order", {"order_id": order_id}))
        if last and last["is_error"] and last["result"].get("error") == "refund_limit_exceeded":
            damage = "cracked screen" if "cracked screen" in request else "damage on arrival"
            handoff = {
                "customer_id": customer["customer_id"],
                "issue_summary": f"{order['item']} from order {order_id} arrived damaged; the customer wants a full refund.",
                "root_cause": f"Damaged in transit (customer reports a {damage}). The ${order['total']:.2f} refund is above "
                              f"the ${AGENT_REFUND_LIMIT:.0f} agent limit, so it needs human approval.",
                "refund_amount": order["total"],
                "actions_taken": [
                    f"Verified identity with get_customer ({customer['customer_id']}, {customer['tier']} tier)",
                    f"Looked up {order_id}: {order['item']}, ${order['total']:.2f}, {order['status']} {order['delivered_on']}",
                    f"Attempted a ${order['total']:.2f} refund: blocked by the ${AGENT_REFUND_LIMIT:.0f} agent refund limit",
                ],
                "recommended_action": f"Approve a full refund of ${order['total']:.2f} to the original payment method "
                                      "and arrange carrier pickup of the damaged unit.",
                "priority": "high" if customer["tier"] == "gold" else "normal",
            }
            return lab.message(lab.text("This refund needs a senior agent's approval; I'll hand it over."),
                               lab.tool_use("escalate_to_human", handoff))
        return lab.message(lab.tool_use("process_refund", {
            "customer_id": customer["customer_id"], "reference_id": order_id, "amount": order["total"],
            "reason": "Item arrived damaged"}))

    return model
