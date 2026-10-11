"""D1.5 - A support agent whose tool calls pass through hooks.

The customer wants a full refund for a $750 legacy order. The system prompt says nothing
about limits, so the agent tries process_refund($750). The PreToolUse hook denies it with
a reason naming escalate_to_human, and the agent escalates. Along the way the PostToolUse
hook turns the legacy order (epoch seconds, status 3, cents) into the canonical record.

    live:     query() with hooks=HOOKS, mcp_servers={"shop": SHOP_SERVER}, allowed_tools
    offline:  the same hooks and @tool handlers, driven by a scripted model through
              harness.run_offline_agent / simulate_tool_call

Run:  python support_agent.py          (offline)
      python support_agent.py --live   (Agent SDK + real Claude; costs tokens)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from harness import content_text, run_offline_agent, simulate_tool_call  # noqa: E402
from hooks import HOOK_EVENTS, HOOKS, REFUND_LIMIT_USD  # noqa: E402
from scripted_model import make_support_model  # noqa: E402
from shop_server import ALLOWED_TOOLS, ESCALATIONS, REFUNDS, SHOP_SERVER, reset_ledgers  # noqa: E402

# Deliberately no refund limit in the prompt: the business rule lives in the hook.
SYSTEM_PROMPT = (
    "You are a customer support agent for an online store. Use the shop tools to look up orders "
    "before acting. Order IDs ORD-1xxx live in the legacy system, ORD-2xxx in v2. Be concise."
)
REQUEST = "Order ORD-1001 arrived damaged. Please refund the customer the full order total."


async def run_live() -> None:
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock, ToolUseBlock, query

    options = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT,
        mcp_servers={"shop": SHOP_SERVER},  # in-process SDK MCP server
        allowed_tools=ALLOWED_TOOLS,  # auto-approve the shop tools; hooks still run first
        tools=[],  # no built-in tools (Bash, Read, ...): this agent only talks to the shop
        hooks=HOOKS,  # type: ignore[arg-type]
        max_turns=12,
        model=lab.MODEL,
    )
    async for message in query(prompt=REQUEST, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    print(f"  tool_use {block.name}({block.input})")
                elif isinstance(block, TextBlock) and block.text.strip():
                    print(f"  assistant: {block.text.strip()}")
        elif isinstance(message, ResultMessage):
            print(f"  result ({message.subtype}, {message.num_turns} turns, ${message.total_cost_usd or 0:.4f}): {message.result}")
            if message.permission_denials:
                lab.show("  permission_denials", message.permission_denials)


async def run_offline() -> list[dict[str, Any]]:
    client = lab.ScriptedClient(make_support_model())
    answer, calls = await run_offline_agent(client, SYSTEM_PROMPT, REQUEST, simulate_tool_call)
    for call in calls:
        outcome = call["outcome"]
        status = "EXECUTED" if outcome["executed"] else "DENIED by PreToolUse"
        print(f"  tool_use {call['name']}({call['input']}) -> {status}")
        for step in outcome["trace"]:
            print(f"      {step}")
        print(f"      model sees: {content_text(outcome['content'])[:160]}")
    print(f"  assistant: {answer}")
    return calls


async def main() -> None:
    lab.banner("D1.5  Support agent with PreToolUse + PostToolUse hooks")
    reset_ledgers()
    HOOK_EVENTS.clear()
    print(f"user: {REQUEST}")

    lab.section("Agent run")
    calls = await run_live() if lab.is_live() else await run_offline()

    lab.section("What the hooks did")
    for event in HOOK_EVENTS:
        print(f"  {event}")
    lab.show("refund ledger", REFUNDS)
    lab.show("escalations", ESCALATIONS)

    # Deterministic in BOTH modes: whatever the model tried, no over-limit refund executed.
    lab.check(all(r["amount"] <= REFUND_LIMIT_USD for r in REFUNDS), "no refund above $500 was executed")
    if not lab.is_live():
        names = [c["name"] for c in calls]
        lab.check(names[0] == "get_order_legacy", "agent looked the order up first")
        lab.check(any(e["hook"] == "PostToolUse" and e["action"] == "normalized" for e in HOOK_EVENTS), "PostToolUse normalized the legacy record")
        lab.check(any(e["action"] == "deny" for e in HOOK_EVENTS), "PreToolUse denied process_refund($750)")
        lab.check(names[-1] == "escalate_to_human" and ESCALATIONS[0]["amount"] == 750.0, "the deny reason redirected the agent to escalate_to_human")


if __name__ == "__main__":
    lab.run(main())
