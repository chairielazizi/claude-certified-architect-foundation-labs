"""D1.5 - Unit-test the hooks offline by calling them exactly the way the SDK does.

    1. Raw tool output: three backends, three date formats, two status vocabularies
    2. PostToolUse normalizer called directly with a realistic input_data dict
    3. PreToolUse refund guard called directly: $750 denied, $500 and $120 allowed
    4. simulate_tool_call(): PreToolUse -> handler -> PostToolUse, like the SDK
    5. Matcher scoping: which hook fires for which tool name

Always offline: no model is involved, only hook callbacks and @tool handlers.
Run:  python hook_demo.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from harness import content_text, matcher_matches, simulate_tool_call  # noqa: E402
from hooks import HOOKS, STATUS_ENUM, enforce_refund_limit, normalize_shop_output  # noqa: E402
from shop_server import ALLOWED_TOOLS, REFUNDS, TOOLS_BY_NAME, mcp_name, reset_ledgers  # noqa: E402

ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
CONTEXT: Any = {"signal": None}  # HookContext; the SDK passes this third argument


def hook_input(event: str, tool: str, tool_input: dict[str, Any], tool_response: Any = None) -> dict[str, Any]:
    """The input_data dict the SDK hands a hook callback (fields per claude_agent_sdk.types)."""
    data: dict[str, Any] = {
        "hook_event_name": event,
        "session_id": "3f1c2d4e-demo",
        "transcript_path": "/tmp/transcript.jsonl",
        "cwd": str(Path.cwd()),
        "tool_name": mcp_name(tool),
        "tool_input": tool_input,
        "tool_use_id": "toolu_demo_01",
    }
    if event == "PostToolUse":
        data["tool_response"] = tool_response
    return data


def date_fields(record: dict[str, Any]) -> list[str]:
    return [k for k in record if k.endswith("_at")]


async def main() -> None:
    lab.banner("D1.5  Hooks unit-tested offline (normalization + refund guard)")
    reset_ledgers()

    lab.section("1. Raw tool output from three systems")
    lookups = [("get_order_legacy", "ORD-1001"), ("get_order_v2", "ORD-2002"), ("get_shipment", "ORD-2002")]
    raw: dict[str, list[dict[str, Any]]] = {}
    for tool, order_id in lookups:
        result = await TOOLS_BY_NAME[tool].handler({"order_id": order_id})  # the @tool function itself
        raw[tool] = result["content"]
        print(f"{tool}: {content_text(result['content'])}")

    lab.section("2. PostToolUse normalizer, called directly")
    canonical: dict[str, dict[str, Any]] = {}
    for tool, order_id in lookups:
        out = await normalize_shop_output(hook_input("PostToolUse", tool, {"order_id": order_id}, raw[tool]), "toolu_demo_01", CONTEXT)
        replaced = out["hookSpecificOutput"]["updatedToolOutput"]
        canonical[tool] = json.loads(content_text(replaced))
        print(f"{tool} ->")
        print(f"  {json.dumps(canonical[tool])}")
    records = list(canonical.values())
    lab.check(all(ISO_UTC.match(r[k]) for r in records for k in date_fields(r)), "every date is ISO 8601 UTC (YYYY-MM-DDTHH:MM:SSZ)")
    lab.check(all(r["status"] in STATUS_ENUM for r in records), f"every status is in the canonical enum {STATUS_ENUM[:4]}...")
    lab.check(canonical["get_order_legacy"]["status"] == "delivered", "legacy numeric status 3 became 'delivered'")
    lab.check(set(canonical["get_order_legacy"]) == set(canonical["get_order_v2"]), "legacy and v2 orders now share one shape")
    lab.check(canonical["get_order_v2"]["created_at"] == "2026-10-05T06:30:00Z", "v2 '+08:00' timestamp was converted to UTC")
    lab.check(canonical["get_shipment"]["shipped_at"].startswith("2026-10-06"), "MM/DD/YYYY 10/06/2026 read as 6 October, not 10 June")
    error_out = await normalize_shop_output(
        hook_input("PostToolUse", "get_order_v2", {"order_id": "ORD-9"}, [{"type": "text", "text": '{"error": "No v2 order"}'}]), None, CONTEXT
    )
    lab.check(error_out == {}, "error results pass through untouched (hook returns {})")

    lab.section("3. PreToolUse refund guard, called directly")
    decisions = {}
    for amount in (750.0, 500.0, 120.0, "lots"):
        out = await enforce_refund_limit(
            hook_input("PreToolUse", "process_refund", {"order_id": "ORD-1001", "amount": amount, "reason": "damaged"}), "toolu_demo_02", CONTEXT
        )
        decision = out.get("hookSpecificOutput", {}).get("permissionDecision", "no opinion -> allowed_tools applies")
        decisions[str(amount)] = out
        print(f"amount={amount!r:>7}: {decision}")
    deny = decisions["750.0"]["hookSpecificOutput"]
    print(f"deny reason: {deny['permissionDecisionReason']}")
    lab.check(deny["permissionDecision"] == "deny", "$750 refund is denied")
    lab.check("escalate_to_human" in deny["permissionDecisionReason"], "the deny reason redirects the agent to escalate_to_human")
    lab.check(decisions["500.0"] == {} and decisions["120.0"] == {}, "$500 (at the limit) and $120 are allowed")
    lab.check(decisions["lots"]["hookSpecificOutput"]["permissionDecision"] == "deny", "an unreadable amount fails closed")

    lab.section("4. simulate_tool_call: PreToolUse -> handler -> PostToolUse")
    big = await simulate_tool_call("process_refund", {"order_id": "ORD-1001", "amount": 750.0, "reason": "damaged"})
    print(f"process_refund $750: executed={big['executed']} trace={big['trace']}")
    lab.check(not big["executed"] and REFUNDS == [], "denied call never reached the handler (refund ledger still empty)")
    small = await simulate_tool_call("process_refund", {"order_id": "ORD-2002", "amount": 120.0, "reason": "late"})
    print(f"process_refund $120: executed={small['executed']} -> {content_text(small['content'])}")
    lab.check(small["executed"] and len(REFUNDS) == 1, "allowed call ran the handler once")
    lookup = await simulate_tool_call("get_order_legacy", {"order_id": "ORD-1001"})
    print(f"get_order_legacy: trace={lookup['trace']}")
    print(f"  raw:  {content_text(lookup['raw'])}")
    print(f"  seen: {content_text(lookup['content'])}")
    lab.check(json.loads(content_text(lookup["content"]))["status"] == "delivered", "the model receives the canonical record, not the raw one")

    lab.section("5. Matcher scoping (matchers see the tool NAME only)")
    for full in ALLOWED_TOOLS:
        fired = [f"{event}[{m.matcher}]" for event, ms in HOOKS.items() for m in ms if matcher_matches(m.matcher, full)]
        print(f"  {full:<32} {fired or '-'}")
    get_tools = [t for t in ALLOWED_TOOLS if matcher_matches("^mcp__shop__get_", t)]
    lab.check(len(get_tools) == 3 and mcp_name("process_refund") not in get_tools, "the PostToolUse regex catches exactly the three get_ tools")


if __name__ == "__main__":
    lab.run(main())
