"""D2.4 - The custom team MCP server: detailed tool descriptions and catalog resources.

Uses the real MCPServer from example-project/servers/team_kb_server.py in-process:
``await server.list_tools()``, ``list_resources()``, ``read_resource(uri)``, ``call_tool``.

  1. what an agent discovers: tools (with descriptions) and resources (catalogs)
  2. why the descriptions win over Grep: they say what the data is, where it lives, what
     comes back, and when to prefer the tool
  3. catalog resources vs exploratory calls: answering "which table holds refund reasons,
     and is there an open issue about them?" with and without reading the catalogs

Always offline (no model involved). Run:  python kb_server_demo.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "example-project" / "servers"))
import labkit as lab  # noqa: E402
from team_kb_server import build_server  # noqa: E402

# Table names an agent would plausibly guess without a catalog (it cannot list the warehouse).
GUESSED_TABLES = ["refunds", "orders", "payments", "refund_log", "refund_events"]


def payload(result: Any) -> dict[str, Any]:
    return json.loads(result.content[0].text)


async def without_catalog(server: Any) -> tuple[str | None, list[str], int]:
    """Exploratory tool calls: guess table names, then search for issues."""
    calls = 0
    table = None
    for guess in GUESSED_TABLES:
        calls += 1
        result = await server.call_tool("describe_table", {"table": guess})
        if not result.is_error and any(c["name"] == "refund_reason" for c in payload(result)["columns"]):
            table = guess
            break
    calls += 1
    hits = payload(await server.call_tool("search_kb", {"query": "refund reason issue"}))
    # The KB holds docs, not tickets: the open issue is not found this way at all.
    issues = [h["doc_id"] for h in hits["results"] if h["doc_id"].startswith("PAY-")]
    return table, issues, calls


async def with_catalog(server: Any) -> tuple[str | None, list[str], int, int]:
    """Read the catalogs first, then make one targeted call."""
    schema = json.loads((await server.read_resource("catalog://db/schema"))[0].content)
    issues = json.loads((await server.read_resource("catalog://issues/summary"))[0].content)
    table = next((name for name, cols in schema.items() if any(c.startswith("refund_reason:") for c in cols)), None)
    keys = [i["key"] for i in issues if "refund reason" in i["title"].lower()]
    detail = await server.call_tool("describe_table", {"table": table})  # one targeted call for column docs
    assert not detail.is_error
    return table, keys, 1, 2


async def main() -> None:
    lab.banner("D2.4  Custom team MCP server: tool descriptions and catalog resources")
    server = build_server()

    lab.section("1. What the agent discovers at connection time")
    tools = await server.list_tools()
    resources = await server.list_resources()
    for tool in tools:
        print(f"  tool     mcp__team-kb__{tool.name:<20} ({len(tool.description)} chars of description)")
    for res in resources:
        print(f"  resource {str(res.uri):<34} {res.mime_type}  {res.description}")

    lab.section("2. A description written to beat Grep")
    search = next(t for t in tools if t.name == "search_kb")
    print("  " + search.description.replace(". ", ".\n  "))

    lab.section("3. Catalog resources vs exploratory tool calls")
    table_a, issues_a, calls_a = await without_catalog(server)
    print(f"  without catalog: table={table_a} issues={issues_a} tool_calls={calls_a}")
    table_b, issues_b, calls_b, reads_b = await with_catalog(server)
    print(f"  with catalog:    table={table_b} issues={issues_b} tool_calls={calls_b} resource_reads={reads_b}")

    lab.section("Checks")
    lab.check({t.name for t in tools} == {"search_kb", "get_doc", "find_service_owner", "describe_table"}, "four team-specific tools discovered")
    lab.check(
        all(len(t.description) > 300 and "return" in t.description.lower() for t in tools),
        "every tool description explains capabilities and outputs in detail (> 300 chars, states what it returns)",
    )
    lab.check("Grep" in search.description and "NOT in this repository" in search.description, "search_kb says why to prefer it over the built-in Grep")
    lab.check({str(r.uri) for r in resources} == {"catalog://issues/summary", "catalog://docs/hierarchy", "catalog://db/schema"},
              "issue summaries, docs hierarchy and database schema exposed as resources")
    lab.check(table_a == table_b == "refund_events", "both strategies find the refund_events table")
    lab.check(calls_b < calls_a, f"catalogs cut exploratory tool calls ({calls_a} -> {calls_b})")
    lab.check(issues_b == ["PAY-311"] and not issues_a, "the issue summary resource surfaces PAY-311, which tool exploration missed")


if __name__ == "__main__":
    lab.run(main())
