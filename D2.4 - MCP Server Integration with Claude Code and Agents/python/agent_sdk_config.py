"""D2.4 - Agent SDK: a stdio MCP server and an in-process SDK server in one agent.

LAB_SKIP_AUTORUN - the query() part is live-only (it drives the Claude Code runtime).
Offline it builds the options, prints them, and calls the in-process tool's handler
directly, so you can see the configuration without a runtime.

  mcp_servers = {
      "team-kb": {"type": "stdio", "command": <python>, "args": [team_kb_server.py, "--serve"], "env": {...}},
      "notes":   create_sdk_mcp_server(name="notes", tools=[save_note]),     # runs in this process
  }

Both servers' tools are discovered at connection time and offered together
(mcp__team-kb__*, mcp__notes__*). The init SystemMessage reports each server's status.

Run:  python agent_sdk_config.py          (offline: print config only)
      python agent_sdk_config.py --live   (real agent run)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from claude_agent_sdk import (  # noqa: E402
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SystemMessage,
    ToolUseBlock,
    create_sdk_mcp_server,
    query,
    tool,
)

PROJECT = Path(__file__).resolve().parents[1] / "example-project"
SERVER = PROJECT / "servers" / "team_kb_server.py"
PROMPT = "Who owns the payments service and what does its runbook say about restarts? Save a one-line note with the answer."
NOTES: list[str] = []


@tool(
    "save_note",
    "Append one line to this session's notes and return {saved, count}. Use it when the user asks you to keep or note an answer.",
    {"text": str},
)
async def save_note(args: dict[str, Any]) -> dict[str, Any]:
    NOTES.append(str(args["text"]))
    return {"content": [{"type": "text", "text": json.dumps({"saved": True, "count": len(NOTES)})}]}


def build_options() -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        mcp_servers={
            # Same server Claude Code starts from .mcp.json; here the SDK starts it as a subprocess.
            "team-kb": {
                "type": "stdio",
                "command": sys.executable,
                "args": [str(SERVER), "--serve"],
                "env": {"KB_URL": os.environ.get("KB_URL", "http://localhost:8080"), "KB_TOKEN": os.environ.get("KB_TOKEN", "")},
            },
            # In-process SDK server: no subprocess, the tool is a Python function in this program.
            "notes": create_sdk_mcp_server(name="notes", version="1.0.0", tools=[save_note]),
        },
        allowed_tools=[
            "mcp__team-kb__find_service_owner",
            "mcp__team-kb__get_doc",
            "mcp__team-kb__search_kb",
            "mcp__notes__save_note",
            "Read",
            "Grep",
            "Glob",
        ],
        disallowed_tools=["Bash", "Write", "Edit"],
        cwd=str(PROJECT),
        max_turns=8,
        model=lab.MODEL,
    )


async def main() -> None:
    lab.banner("D2.4  Agent SDK: stdio MCP server + in-process SDK MCP server")
    options = build_options()
    servers = options.mcp_servers
    assert isinstance(servers, dict)
    lab.show("mcp_servers", {name: {k: (v if k != "instance" else "<in-process MCP server>") for k, v in cfg.items()} for name, cfg in servers.items()})
    lab.show("allowed_tools", options.allowed_tools)

    lab.section("In-process tool, called directly (no runtime needed)")
    print(f"  save_note -> {await save_note.handler({'text': 'offline smoke test'})}")

    lab.check(servers["team-kb"].get("type") == "stdio" and servers["notes"].get("type") == "sdk", "one stdio server and one in-process SDK server configured together")
    lab.check(NOTES == ["offline smoke test"], "the SDK tool is ordinary Python and ran in-process")

    if not lab.is_live():
        print("\nThe agent run needs the Claude Code runtime. Re-run with --live.")
        return

    lab.section("Live agent run")
    result = None
    async for message in query(prompt=PROMPT, options=options):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            # Shape follows the Claude Code init message: [{"name": ..., "status": "connected" | "failed" | ...}]
            print(f"  MCP server status: {message.data.get('mcp_servers')}")
            print(f"  MCP tools offered: {[t for t in message.data.get('tools', []) if str(t).startswith('mcp__')]}")
        elif isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    print(f"  tool_use {block.name} {block.input}")
        elif isinstance(message, ResultMessage):
            result = message
            print(f"  result ({message.subtype}): {message.result}")
    lab.check(result is not None and not result.is_error, "agent finished using tools from both servers")


if __name__ == "__main__":
    lab.run(main())
