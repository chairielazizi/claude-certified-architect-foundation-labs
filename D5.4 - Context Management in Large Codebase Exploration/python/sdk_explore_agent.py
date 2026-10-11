"""D5.4 - The delegation pattern with the Claude Agent SDK: an Explore-style subagent.

The main agent gets one subagent definition, "explorer", restricted to the read-only
built-ins Read, Grep and Glob. Verbose discovery happens inside the subagent's own context;
only its summary comes back. The main agent needs "Agent" in allowed_tools to spawn it
(the tool was renamed from "Task" in Claude Code v2.1.63; "Task" remains an alias).

Offline this validates and prints the configuration. With --live it runs against the
fixture repo (requires the Claude Code runtime that claude-agent-sdk drives).

Run:  python sdk_explore_agent.py          (offline: configuration only)
      python sdk_explore_agent.py --live   (real agent run)
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions  # noqa: E402
from explorer import REPO  # noqa: E402

READ_ONLY = {"Read", "Grep", "Glob"}

EXPLORER = AgentDefinition(
    description=(
        "Read-only codebase explorer. Use it for verbose discovery (finding files, tracing call chains) "
        "so the main conversation only receives a concise summary."
    ),
    prompt=(
        "You explore a repository with Read, Grep and Glob only. Return a concise summary with exact class "
        "names, file paths, constants and call order. Never paste whole files."
    ),
    tools=["Read", "Grep", "Glob"],
    model="inherit",
)

OPTIONS = ClaudeAgentOptions(
    cwd=str(REPO),
    agents={"explorer": EXPLORER},
    allowed_tools=["Read", "Grep", "Glob", "Agent"],  # "Agent" spawns subagents
    disallowed_tools=["Write", "Edit", "Bash"],
    max_turns=20,
)

PROMPT = (
    "Use the explorer subagent twice, in parallel: (1) find all test files and what each covers; "
    "(2) trace the refund flow starting from post_refund. Then give me a five-line summary with exact class names."
)


async def run_live() -> None:
    from claude_agent_sdk import AssistantMessage, ResultMessage, ToolUseBlock, query

    async for message in query(prompt=PROMPT, options=OPTIONS):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock) and block.name in ("Agent", "Task"):
                    print(f"  delegated to {block.input.get('subagent_type', '?')}: {str(block.input.get('description', ''))[:70]}")
        elif isinstance(message, ResultMessage):
            print(f"result ({message.subtype}, {message.num_turns} turns):\n{message.result}")


def main() -> None:
    lab.banner("D5.4  Explore-style subagent with the Claude Agent SDK")
    lab.section("Subagent definition")
    lab.show("agents['explorer']", {k: v for k, v in dataclasses.asdict(EXPLORER).items() if v is not None})
    lab.section("Main agent options")
    lab.show("options", {"cwd": Path(OPTIONS.cwd).relative_to(REPO.parents[1]).as_posix(), "allowed_tools": OPTIONS.allowed_tools,
                         "disallowed_tools": OPTIONS.disallowed_tools, "max_turns": OPTIONS.max_turns})

    lab.section("Checks")
    lab.check(set(EXPLORER.tools or []) <= READ_ONLY, "the explorer subagent can only read (Read, Grep, Glob)")
    lab.check("Agent" in OPTIONS.allowed_tools, "the main agent may spawn subagents ('Agent', formerly 'Task')")
    lab.check(not READ_ONLY & set(OPTIONS.disallowed_tools) and "Write" in OPTIONS.disallowed_tools, "nothing can write to the repo")
    lab.check(Path(OPTIONS.cwd).is_dir(), "cwd points at the fixture repo")

    if lab.is_live():
        lab.section("Live run")
        lab.run(run_live())
    else:
        print("\noffline: configuration only. Re-run with --live to watch the delegation happen.")


if __name__ == "__main__":
    main()
