"""Offline stand-in for what the Agent SDK does around every tool call.

    simulate_tool_call(name, input):
        PreToolUse hooks (matching by tool name)  -> any "deny" wins, the handler never runs
        tool handler (the @tool function)         -> raw backend output
        PostToolUse hooks                         -> updatedToolOutput replaces what the model sees

    run_offline_agent(...): the agentic loop query() runs for you, driven by a scripted
    model, with every tool call routed through an executor (hooked or not).

With the real SDK you never write this: you pass hooks=HOOKS and mcp_servers=... to
ClaudeAgentOptions and Claude Code applies them. Writing it once makes the order of
operations, and the "deny means the handler does not run" guarantee, explicit and testable.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from claude_agent_sdk import HookMatcher  # noqa: E402
from hooks import HOOKS  # noqa: E402
from shop_server import API_TOOL_DEFS, TOOLS_BY_NAME, mcp_name, short_name  # noqa: E402


def matcher_matches(matcher: str | None, tool_name: str) -> bool:
    """Approximates Claude Code's matcher rules: empty or "*" matches everything; a plain
    name (letters, digits, _ and |) is an exact match against |-separated names; anything
    else is a regular expression searched in the tool name."""
    if not matcher or matcher == "*":
        return True
    if re.fullmatch(r"[A-Za-z0-9_|]+", matcher):
        return tool_name in matcher.split("|")
    return re.search(matcher, tool_name) is not None


def content_text(content: Any) -> str:
    """The text the model would read from a tool result."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        content = content.get("content", [])
    return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")


async def simulate_tool_call(
    name: str,
    tool_input: dict[str, Any],
    tool_use_id: str = "toolu_offline",
    hooks: dict[str, list[HookMatcher]] | None = None,
) -> dict[str, Any]:
    hooks = HOOKS if hooks is None else hooks
    full_name = name if name.startswith("mcp__") else mcp_name(name)
    base = {
        "session_id": "offline-session",
        "transcript_path": "",
        "cwd": str(Path.cwd()),
        "tool_name": full_name,
        "tool_input": tool_input,
        "tool_use_id": tool_use_id,
    }
    trace: list[str] = []

    # 1) PreToolUse: every matching hook runs; one "deny" beats any number of "allow"s.
    deny_reason: str | None = None
    for m in hooks.get("PreToolUse", []):
        if not matcher_matches(m.matcher, full_name):
            continue
        for callback in m.hooks:
            pre_input = {**base, "tool_input": tool_input, "hook_event_name": "PreToolUse"}
            out = await callback(pre_input, tool_use_id, {"signal": None})
            spec = out.get("hookSpecificOutput", {})
            decision = spec.get("permissionDecision", "none")
            trace.append(f"PreToolUse[{m.matcher}] -> {decision}")
            if decision == "deny" and deny_reason is None:
                deny_reason = spec.get("permissionDecisionReason", "Denied by hook")
            if "updatedInput" in spec:
                tool_input = spec["updatedInput"]  # a hook may rewrite the arguments
    if deny_reason is not None:
        # The handler never runs. The model receives the reason as an error tool result.
        return {"executed": False, "is_error": True, "content": [{"type": "text", "text": deny_reason}], "trace": trace}

    # 2) The tool itself.
    result = await TOOLS_BY_NAME[short_name(full_name)].handler(tool_input)
    raw_content = result["content"]
    trace.append(f"handler {short_name(full_name)} ran")

    # 3) PostToolUse: a hook can replace the output before the model processes it.
    content: Any = raw_content
    for m in hooks.get("PostToolUse", []):
        if not matcher_matches(m.matcher, full_name):
            continue
        for callback in m.hooks:
            post_input = {**base, "tool_input": tool_input, "hook_event_name": "PostToolUse", "tool_response": raw_content}
            out = await callback(post_input, tool_use_id, {"signal": None})
            spec = out.get("hookSpecificOutput", {})
            if "updatedToolOutput" in spec:
                content = spec["updatedToolOutput"]
                trace.append(f"PostToolUse[{m.matcher}] -> replaced output")
    return {
        "executed": True,
        "is_error": bool(result.get("is_error")),
        "content": content,
        "raw": raw_content,
        "trace": trace,
    }


async def run_tool_unhooked(name: str, tool_input: dict[str, Any], tool_use_id: str = "toolu_offline") -> dict[str, Any]:
    """The same call with no hooks registered: raw output, no policy check."""
    return await simulate_tool_call(name, tool_input, tool_use_id, hooks={})


Executor = Callable[[str, dict[str, Any], str], Awaitable[dict[str, Any]]]


async def run_offline_agent(
    client: Any, system: str, request: str, executor: Executor, max_iterations: int = 10
) -> tuple[str, list[dict[str, Any]]]:
    """A stop_reason-driven loop (see D1.1) whose tool calls go through `executor`.

    Returns (final_text, calls) where calls lists {name, input, outcome} in order."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": request}]
    calls: list[dict[str, Any]] = []
    for _ in range(max_iterations):
        response = client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=system, tools=API_TOOL_DEFS, messages=messages
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return lab.text_of(response), calls
        results = []
        for block in lab.tool_uses(response):
            outcome = await executor(block.name, block.input, block.id)
            calls.append({"name": short_name(block.name), "input": block.input, "outcome": outcome})
            result = {"type": "tool_result", "tool_use_id": block.id, "content": content_text(outcome["content"])}
            if outcome["is_error"]:
                result["is_error"] = True
            results.append(result)
        messages.append({"role": "user", "content": results})
    raise RuntimeError(f"Agent did not finish in {max_iterations} iterations")
