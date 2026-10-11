"""Customer-support MCP server whose tools return STRUCTURED errors (D2.2).

LAB_SKIP_AUTORUN - this module is imported by the demos. It only starts a real stdio
MCP server when run with --serve (that call blocks, waiting for an MCP client):

    python support_server.py --serve            # structured errors
    python support_server.py --serve --generic  # contrast: every failure is "Operation failed"

Every failed tool call returns a CallToolResult with ``isError: true`` and a JSON envelope
the agent can act on:

    {"errorCategory": "transient" | "validation" | "business" | "permission",
     "isRetryable": bool,
     "message": "...",                 # for the agent: what happened, what to do next
     "customerMessage": "...",         # business rules only: safe to say to the customer
     "retryAfterSeconds": 2,           # transient only
     "details": {...}}

A search with no matches is NOT an error: it is a successful query whose answer is
"nothing found" ({"results": [], "matched": 0}). Only access failures are errors.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from typing import Annotated, Any, Callable

import mcp.types as t
from mcp.server import MCPServer
from pydantic import Field

ORDER_ID = re.compile(r"^ORD-\d{4}$")
REFUND_LIMIT = 500.00  # refunds above this need a supervisor (a business rule, not an error in the code)

# ---------------------------------------------------------------------------
# Fake backend with injectable failures. It also keeps a ground-truth log of what
# REALLY happened on each call, so the demos can count wasted retries objectively.
# ---------------------------------------------------------------------------


class BackendTimeout(Exception):
    pass


@dataclass
class Backend:
    orders: dict[str, dict[str, Any]] = field(
        default_factory=lambda: {
            "ORD-1001": {"order_id": "ORD-1001", "account": "consumer", "status": "delivered", "total": 1199.00, "items": ["4K monitor"]},
            "ORD-1002": {"order_id": "ORD-1002", "account": "consumer", "status": "shipped", "total": 89.90, "items": ["Headphones"]},
            "ORD-3003": {"order_id": "ORD-3003", "account": "corporate", "status": "delivered", "total": 240.00, "items": ["Docking station"]},
        }
    )
    kb: list[dict[str, str]] = field(
        default_factory=lambda: [
            {"id": "KB-12", "title": "Return window for electronics", "snippet": "30 days from delivery; 15 days for opened headphones."},
            {"id": "KB-31", "title": "Refund approval limits", "snippet": "Agents may refund up to $500; above that a supervisor approves."},
        ]
    )
    lookup_timeouts: dict[str, int] = field(default_factory=dict)  # order_id -> timeouts still to inject
    kb_down: bool = False
    caller_scopes: set[str] = field(default_factory=lambda: {"orders:read", "refunds:write"})
    log: list[dict[str, Any]] = field(default_factory=list)

    def record(self, tool: str, args: dict[str, Any], outcome: str) -> None:
        self.log.append({"tool": tool, "args": dict(args), "outcome": outcome})

    def get_order(self, order_id: str) -> dict[str, Any] | None:
        if self.lookup_timeouts.get(order_id, 0) > 0:
            self.lookup_timeouts[order_id] -= 1
            raise BackendTimeout("order service did not answer within 2s")
        return self.orders.get(order_id)

    def search(self, query: str, limit: int) -> list[dict[str, str]]:
        if self.kb_down:
            raise BackendTimeout("knowledge-base cluster unavailable (503)")
        words = {w for w in re.findall(r"[a-z]+", query.lower()) if len(w) > 3}
        hits = [doc for doc in self.kb if words & set(re.findall(r"[a-z]+", (doc["title"] + " " + doc["snippet"]).lower()))]
        return hits[:limit]


# ---------------------------------------------------------------------------
# The error envelope
# ---------------------------------------------------------------------------


class ToolFailure(Exception):
    """A failure the tool understands well enough to classify."""

    def __init__(
        self,
        category: str,
        message: str,
        *,
        retryable: bool,
        customer_message: str | None = None,
        retry_after_s: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.category = category
        self.envelope: dict[str, Any] = {"errorCategory": category, "isRetryable": retryable, "message": message}
        if customer_message:
            self.envelope["customerMessage"] = customer_message
        if retry_after_s is not None:
            self.envelope["retryAfterSeconds"] = retry_after_s
        self.envelope["details"] = details or {}


def _text(payload: dict[str, Any] | str, is_error: bool = False) -> t.CallToolResult:
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return t.CallToolResult(content=[t.TextContent(type="text", text=text)], is_error=is_error)


# ---------------------------------------------------------------------------
# Tool logic (pure functions over the backend; raise ToolFailure on failure)
# ---------------------------------------------------------------------------


def _validate_order_id(order_id: str) -> None:
    if not ORDER_ID.match(order_id):
        raise ToolFailure(
            "validation",
            f"order_id {order_id!r} is not in the format ORD-#### (for example ORD-1001). "
            "Correct the value and call again; retrying the same value will fail the same way.",
            retryable=False,
            details={"field": "order_id", "expected_format": "ORD-####", "received": order_id},
        )


def _fetch_order(backend: Backend, order_id: str) -> dict[str, Any] | None:
    try:
        return backend.get_order(order_id)
    except BackendTimeout as exc:
        raise ToolFailure(
            "transient",
            f"Order service timed out ({exc}). Safe to retry the same call after a short wait.",
            retryable=True,
            retry_after_s=1,
            details={"service": "orders", "timeout_s": 2},
        ) from exc


def lookup_order_logic(backend: Backend, order_id: str) -> dict[str, Any]:
    _validate_order_id(order_id)
    order = _fetch_order(backend, order_id)
    if order is None:
        # Not found by exact id is a valid answer, not an access failure.
        return {"found": False, "order_id": order_id}
    return {"found": True, **order}


def process_refund_logic(backend: Backend, order_id: str, amount: float) -> dict[str, Any]:
    _validate_order_id(order_id)
    if amount <= 0:
        raise ToolFailure(
            "validation",
            f"amount must be a positive number of dollars, got {amount}.",
            retryable=False,
            details={"field": "amount", "received": amount},
        )
    order = _fetch_order(backend, order_id)
    if order is None:
        raise ToolFailure(
            "validation",
            f"No order {order_id}; check the id with the customer.",
            retryable=False,
            details={"field": "order_id", "received": order_id},
        )
    if order["account"] == "corporate" and "refunds:corporate" not in backend.caller_scopes:
        raise ToolFailure(
            "permission",
            "This credential lacks the refunds:corporate scope required for refunds on corporate "
            "accounts. Do not retry; escalate to a human agent who holds that scope.",
            retryable=False,
            details={"required_scope": "refunds:corporate", "caller_scopes": sorted(backend.caller_scopes)},
        )
    if amount > REFUND_LIMIT:
        raise ToolFailure(
            "business",
            f"Refund of ${amount:.2f} exceeds the ${REFUND_LIMIT:.0f} agent limit (policy REFUND-4.2). "
            "Not retryable. Explain to the customer using customerMessage and offer a supervisor review.",
            retryable=False,
            customer_message=(
                f"Refunds over ${REFUND_LIMIT:.0f} need a supervisor's approval, so I can't issue this "
                "one directly. I can request a supervisor review for you."
            ),
            details={"policy": "REFUND-4.2", "limit": REFUND_LIMIT, "requested": amount},
        )
    if amount > order["total"]:
        raise ToolFailure(
            "business",
            f"Refund ${amount:.2f} is more than the order total ${order['total']:.2f}.",
            retryable=False,
            customer_message=f"I can refund at most the order total of ${order['total']:.2f}.",
            details={"order_total": order["total"], "requested": amount},
        )
    return {"refund_id": f"RF-{order_id[-4:]}", "status": "issued", "amount": amount}


def search_kb_logic(backend: Backend, query: str, limit: int) -> dict[str, Any]:
    if not query.strip():
        raise ToolFailure("validation", "query must not be empty.", retryable=False, details={"field": "query"})
    try:
        hits = backend.search(query, limit)
    except BackendTimeout as exc:
        raise ToolFailure(
            "transient",
            f"Knowledge base unavailable ({exc}). This is an access failure, not 'no results'. "
            "Safe to retry after the suggested wait.",
            retryable=True,
            retry_after_s=2,
            details={"service": "kb"},
        ) from exc
    # Zero hits is a SUCCESSFUL query. Returning isError here would make the agent retry
    # a question that was already answered ("nothing matches").
    return {"results": hits, "matched": len(hits), "query": query}


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------

DESCRIPTIONS = {
    "lookup_order": (
        "Fetch one order by id and return {found, order_id, status, total, items, account}. "
        "Input: order_id in the format ORD-#### (for example ORD-1001). An unknown id is a "
        "successful lookup with found=false. Errors come back with isError and a JSON body "
        "{errorCategory, isRetryable, message, details}: transient (timeouts, safe to retry), "
        "validation (bad id format, fix the input)."
    ),
    "process_refund": (
        "Issue a refund for an order and return {refund_id, status, amount}. Input: order_id "
        "(ORD-####) and amount in dollars. Agents may refund up to $500 on consumer accounts. "
        "Errors come back with isError and {errorCategory, isRetryable, message, customerMessage?, "
        "details}: business (policy limits - never retry; tell the customer using customerMessage), "
        "permission (escalate), validation (fix the input)."
    ),
    "search_kb": (
        "Search the support knowledge base and return {results: [{id, title, snippet}], matched, "
        "query}. matched=0 means the query worked and nothing matched - do not retry it; "
        "rephrase or answer without the KB. Errors (isError) are access failures only: "
        "transient with retryAfterSeconds when the KB is down."
    ),
}


def build_server(backend: Backend, style: str = "structured") -> MCPServer:
    """The same three tools; ``style`` controls only how failures are reported."""
    server = MCPServer("support-tools" if style == "structured" else "support-tools-generic", version="1.0.0")

    def respond(tool: str, args: dict[str, Any], op: Callable[[], dict[str, Any]]) -> t.CallToolResult:
        try:
            payload = op()
        except ToolFailure as failure:
            backend.record(tool, args, failure.category)
            if style == "generic":
                # The anti-pattern: one uniform message for every failure.
                return _text({"error": "Operation failed"}, is_error=True)
            return _text(failure.envelope, is_error=True)
        empty = payload.get("matched") == 0
        backend.record(tool, args, "empty" if empty else "ok")
        if style == "generic" and empty:
            # A common companion bug: "no results" raised as an exception -> reported as failure.
            return _text({"error": "Operation failed"}, is_error=True)
        return _text(payload)

    @server.tool(description=DESCRIPTIONS["lookup_order"])
    def lookup_order(order_id: Annotated[str, Field(description="Order id, format ORD-#### (ORD-1001)")]) -> t.CallToolResult:
        return respond("lookup_order", {"order_id": order_id}, lambda: lookup_order_logic(backend, order_id))

    @server.tool(description=DESCRIPTIONS["process_refund"])
    def process_refund(
        order_id: Annotated[str, Field(description="Order id, format ORD-####")],
        amount: Annotated[float, Field(description="Refund amount in dollars, > 0")],
    ) -> t.CallToolResult:
        args = {"order_id": order_id, "amount": amount}
        return respond("process_refund", args, lambda: process_refund_logic(backend, order_id, amount))

    @server.tool(description=DESCRIPTIONS["search_kb"])
    def search_kb(
        query: Annotated[str, Field(description="Natural-language search query")],
        limit: Annotated[int, Field(description="Maximum results to return (1-10)")] = 5,
    ) -> t.CallToolResult:
        return respond("search_kb", {"query": query}, lambda: search_kb_logic(backend, query, limit))

    return server


if __name__ == "__main__":
    if "--serve" in sys.argv:
        # stdio transport: stdout belongs to the MCP protocol, so never print here.
        build_server(Backend(), "generic" if "--generic" in sys.argv else "structured").run()
    else:
        print("Run with --serve to start the stdio MCP server (add --generic for the contrast variant).")
        print("For the offline demo run: python recovery_demo.py")
