"""Team knowledge-base MCP server: the team-specific custom server in .mcp.json (D2.4).

LAB_SKIP_AUTORUN - imported by the lab demos; runs as a real stdio MCP server only with
--serve (that call blocks waiting for an MCP client such as Claude Code):

    python servers/team_kb_server.py --serve

Why a CUSTOM server here: GitHub and Jira are standard integrations with existing
community/vendor MCP servers (see .mcp.json), so the team does not rebuild them. Its
runbooks, ADRs, service ownership and warehouse schema are team-specific, so they get a
small custom server.

Two design points from the exam:
* Tool descriptions spell out capabilities and outputs in detail, including why to prefer
  them over the built-in Grep (the data is not in the repository at all).
* Resources expose content CATALOGS (issue summaries, docs hierarchy, database schema),
  so an agent can see what exists without spending exploratory tool calls.

The data below is an in-memory fixture. A real server would call KB_URL with KB_TOKEN
(both injected through ${VAR} expansion in .mcp.json, never committed).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Annotated, Any

import mcp.types as t
from mcp.server import MCPServer
from pydantic import Field

KB_URL = os.environ.get("KB_URL", "http://localhost:8080")

DOCS: dict[str, dict[str, Any]] = {
    "RB-014": {"title": "Payments service runbook", "kind": "runbook", "path": "runbooks/payments.md", "updated": "2026-09-30",
               "body": "Restart order: ledger-worker, then payments-api. Refund backlog alarms page #payments-oncall."},
    "ADR-007": {"title": "ADR-007: Postgres for the refund ledger", "kind": "adr", "path": "adr/007-refund-ledger.md", "updated": "2025-11-02",
                "body": "We chose Postgres over DynamoDB for refunds because finance needs ad-hoc SQL and strict consistency."},
    "PM-2026-03": {"title": "Postmortem: duplicate refunds on 2026-03-14", "kind": "postmortem", "path": "postmortems/2026-03-14.md", "updated": "2026-03-20",
                   "body": "A retry without an idempotency key issued 212 duplicate refunds. Fix: idempotency keys on process_refund."},
    "GD-001": {"title": "Onboarding: how we deploy", "kind": "guide", "path": "guides/deploy.md", "updated": "2026-08-12",
               "body": "Deploys go through the release train on Tuesdays and Thursdays; hotfixes need an on-call approver."},
}
SERVICES: dict[str, dict[str, str]] = {
    "payments": {"team": "Payments Platform", "oncall": "payments-primary", "slack": "#payments-oncall", "runbook": "RB-014"},
    "search": {"team": "Discovery", "oncall": "discovery-primary", "slack": "#discovery", "runbook": "RB-022"},
}
TABLES: dict[str, dict[str, Any]] = {
    "orders": {"rows": 1_204_331, "columns": [
        {"name": "order_id", "type": "text", "description": "ORD-#### id", "pii": False},
        {"name": "customer_id", "type": "text", "description": "FK customers", "pii": False},
        {"name": "total", "type": "numeric(10,2)", "description": "Order total in USD", "pii": False}]},
    "customers": {"rows": 310_552, "columns": [
        {"name": "customer_id", "type": "text", "description": "C-#### id", "pii": False},
        {"name": "email", "type": "text", "description": "Login email", "pii": True}]},
    "refund_events": {"rows": 48_920, "columns": [
        {"name": "refund_id", "type": "text", "description": "RF-#### id", "pii": False},
        {"name": "order_id", "type": "text", "description": "FK orders", "pii": False},
        {"name": "refund_reason", "type": "text", "description": "Agent-selected reason code (DAMAGED, LATE, ...)", "pii": False},
        {"name": "idempotency_key", "type": "uuid", "description": "Added after PM-2026-03", "pii": False}]},
}
ISSUES = [
    {"key": "PAY-311", "title": "Refund reason codes not validated against enum", "status": "open", "service": "payments", "severity": "medium"},
    {"key": "PAY-298", "title": "Ledger worker memory leak under backlog", "status": "in_progress", "service": "payments", "severity": "high"},
    {"key": "DSC-120", "title": "Synonyms missing for 'headphones'", "status": "open", "service": "search", "severity": "low"},
]

DESCRIPTIONS = {
    "search_kb": (
        "Search the team knowledge base: runbooks, architecture decision records (ADRs), postmortems "
        "and onboarding guides (about 1,200 pages held by the KB service, NOT in this repository, so "
        "the built-in Grep and Glob tools cannot see them). Matches by meaning as well as words: "
        "'why did we pick Postgres for refunds' finds ADR-007. Returns {matched, results: [{doc_id, "
        "title, kind, path, updated, snippet}]}; matched=0 is a valid answer, not an error. Input: "
        "query in plain language, optional kind (runbook|adr|postmortem|guide), limit 1-20 (default 5). "
        "Prefer this over Grep for how/why questions, incident history and team conventions; use Grep "
        "only to search code in this repository. Follow up with get_doc for the full text."
    ),
    "get_doc": (
        "Return the full markdown of one knowledge-base document with its metadata: {doc_id, title, "
        "kind, path, updated, body}. Input: doc_id as returned by search_kb or listed in the "
        "catalog://docs/hierarchy resource (for example RB-014, ADR-007). Unknown ids return an error "
        "with isError true. Use this instead of reading files: KB documents are not on disk here."
    ),
    "find_service_owner": (
        "Look up who owns a service in the service catalog: returns {service, team, oncall, slack, "
        "runbook} where runbook is a doc_id for get_doc. Input: service name such as payments or "
        "search. Use it for 'who do I page', 'which team owns', 'where is the runbook' questions; "
        "CODEOWNERS files in the repo are often stale, this catalog is the source of truth."
    ),
    "describe_table": (
        "Describe one analytics-warehouse table: returns {table, rows, columns: [{name, type, "
        "description, pii}]}. Input: table name exactly as listed in the catalog://db/schema "
        "resource (read that first instead of guessing names). Columns flagged pii=true must not be "
        "selected into reports. Unknown tables return an error with isError true."
    ),
}


def _json(payload: Any, is_error: bool = False) -> t.CallToolResult:
    return t.CallToolResult(content=[t.TextContent(type="text", text=json.dumps(payload))], is_error=is_error)


def search_docs(query: str, kind: str | None = None, limit: int = 5) -> dict[str, Any]:
    words = {w.strip("?'.,").lower() for w in query.split() if len(w) > 3}
    hits = []
    for doc_id, doc in DOCS.items():
        if kind and doc["kind"] != kind:
            continue
        text = f"{doc['title']} {doc['body']}".lower()
        if any(w in text for w in words):
            hits.append({"doc_id": doc_id, **{k: doc[k] for k in ("title", "kind", "path", "updated")}, "snippet": doc["body"][:80]})
    return {"matched": len(hits[:limit]), "results": hits[:limit], "source": KB_URL}


def build_server() -> MCPServer:
    server = MCPServer("team-kb", version="1.0.0", instructions="Team knowledge base, service catalog and warehouse schema.")

    @server.tool(description=DESCRIPTIONS["search_kb"])
    def search_kb(
        query: Annotated[str, Field(description="Plain-language question or keywords")],
        kind: Annotated[str | None, Field(description="Optional filter: runbook, adr, postmortem or guide")] = None,
        limit: Annotated[int, Field(description="Maximum results, 1-20")] = 5,
    ) -> t.CallToolResult:
        return _json(search_docs(query, kind, limit))

    @server.tool(description=DESCRIPTIONS["get_doc"])
    def get_doc(doc_id: Annotated[str, Field(description="Document id such as RB-014 or ADR-007")]) -> t.CallToolResult:
        doc = DOCS.get(doc_id)
        if doc is None:
            return _json({"errorCategory": "validation", "isRetryable": False, "message": f"unknown doc_id {doc_id}; see catalog://docs/hierarchy"}, True)
        return _json({"doc_id": doc_id, **doc})

    @server.tool(description=DESCRIPTIONS["find_service_owner"])
    def find_service_owner(service: Annotated[str, Field(description="Service name, for example payments")]) -> t.CallToolResult:
        owner = SERVICES.get(service.lower())
        if owner is None:
            return _json({"errorCategory": "validation", "isRetryable": False, "message": f"unknown service {service}", "details": {"known": sorted(SERVICES)}}, True)
        return _json({"service": service.lower(), **owner})

    @server.tool(description=DESCRIPTIONS["describe_table"])
    def describe_table(table: Annotated[str, Field(description="Table name from catalog://db/schema")]) -> t.CallToolResult:
        info = TABLES.get(table)
        if info is None:
            return _json({"errorCategory": "validation", "isRetryable": False, "message": f"unknown table {table}; read catalog://db/schema"}, True)
        return _json({"table": table, **info})

    # --- Resources: catalogs the agent (or the app) can read without exploratory tool calls ---

    @server.resource("catalog://issues/summary", description="Open issues for team services: key, title, status, service, severity.", mime_type="application/json")
    def issues_summary() -> str:
        return json.dumps(ISSUES)

    @server.resource("catalog://docs/hierarchy", description="Knowledge-base tree by kind with doc_id, title and last update.", mime_type="application/json")
    def docs_hierarchy() -> str:
        tree: dict[str, list[dict[str, str]]] = {}
        for doc_id, doc in DOCS.items():
            tree.setdefault(doc["kind"], []).append({"doc_id": doc_id, "title": doc["title"], "updated": doc["updated"]})
        return json.dumps(tree)

    @server.resource("catalog://db/schema", description="Warehouse tables with column names and types (no data). Read before describe_table.", mime_type="application/json")
    def db_schema() -> str:
        return json.dumps({name: [f"{c['name']}:{c['type']}" for c in info["columns"]] for name, info in TABLES.items()})

    return server


if __name__ == "__main__":
    if "--serve" in sys.argv:
        build_server().run()  # stdio: stdout is the protocol channel, so never print here
    else:
        print("Run with --serve to start the stdio MCP server (Claude Code does this via .mcp.json).")
