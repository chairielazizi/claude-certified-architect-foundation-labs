"""D2.5 - A read-only exploration agent with the Agent SDK (Read, Grep, Glob only).

LAB_SKIP_AUTORUN - the query() part is live-only (it drives the Claude Code runtime).
Offline it prints the options and the prompt.

    ClaudeAgentOptions(tools=["Read", "Grep", "Glob"], allowed_tools=[...same...], cwd=sample_repo)

``tools`` restricts which built-in tools exist at all (no Write/Edit/Bash), and
``allowed_tools`` auto-approves the ones that remain. The prompt asks for the
incremental strategy: Grep for entry points and call sites, Read only what is on the
path, and resolve re-exports and aliases.

Run:  python explore_agent.py          (offline: print config only)
      python explore_agent.py --live   (real agent run)
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, ToolUseBlock, query  # noqa: E402

SAMPLE_REPO = Path(__file__).resolve().parents[1] / "sample_repo"
READ_ONLY = ["Read", "Grep", "Glob"]

PROMPT = (
    "Where is the card actually charged when the app checks out a cart, and which other code "
    "paths move money through the same function? Work incrementally: Grep for the entry point "
    "and for call sites, Read only files on the path, and follow imports including re-exports "
    "in __init__.py and 'import X as Y' aliases. Do not read every file. Answer with the chain "
    "of file:function hops and the list of callers."
)


def build_options() -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        tools=READ_ONLY,  # the only built-ins that exist for this agent
        allowed_tools=READ_ONLY,  # auto-approved
        cwd=str(SAMPLE_REPO),
        max_turns=15,
        model=lab.MODEL,
    )


async def main() -> None:
    lab.banner("D2.5  Read-only exploration agent (Agent SDK: Read, Grep, Glob)")
    options = build_options()
    lab.show("options", {"tools": options.tools, "allowed_tools": options.allowed_tools, "cwd": "sample_repo/", "max_turns": options.max_turns})
    print(f"prompt: {PROMPT}")
    lab.check(set(options.tools or []) == set(READ_ONLY) and not {"Write", "Edit", "Bash"} & set(options.allowed_tools), "agent cannot modify files or run commands")

    if not lab.is_live():
        print("\nThe agent run needs the Claude Code runtime. Re-run with --live.")
        return

    used: Counter[str] = Counter()
    result = None
    async for message in query(prompt=PROMPT, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    used[block.name] += 1
                    print(f"  {block.name} {block.input}")
        elif isinstance(message, ResultMessage):
            result = message
            print(f"\nresult ({message.subtype}, {message.num_turns} turns):\n{message.result}")
    total = len([p for p in SAMPLE_REPO.rglob("*") if p.is_file()])
    print(f"\ntool usage: {dict(used)}; Read calls {used['Read']} vs {total} files in the repo")
    lab.check(result is not None and not result.is_error, "exploration finished")
    lab.check(set(used) <= set(READ_ONLY), "only read-only tools were used")


if __name__ == "__main__":
    lab.run(main())
