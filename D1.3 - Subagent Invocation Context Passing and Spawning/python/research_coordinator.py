"""D1.3 - A research coordinator built with the Claude Agent SDK.

    query(prompt, options=ClaudeAgentOptions(
        system_prompt = goals + quality criteria,
        agents        = {"web-researcher": AgentDefinition(...), "doc-analyst": ..., "synthesizer": ...},
        allowed_tools = ["Agent", ...]))          # "Agent" = the spawning tool (exam: "Task")

Offline: prints and checks the options, then replays a recorded message stream through the
same delegation detector the live run uses. Live: runs the coordinator for real and prints every
delegation as it happens.

Run:  python research_coordinator.py          (offline)
      python research_coordinator.py --live   (needs the Claude Code runtime; costs tokens)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from agent_definitions import (  # noqa: E402
    COORDINATOR_PROMPT,
    PROCEDURAL_PROMPT,
    TOPIC,
    build_options,
    is_delegation,
    steps_in,
)
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ToolUseBlock, query  # noqa: E402

WEB_TOOLS = {"WebSearch", "WebFetch"}


def describe_message(message: Any) -> list[str]:
    """Human-readable lines for the parts of the stream that show orchestration."""
    lines: list[str] = []
    if isinstance(message, AssistantMessage):
        # Messages produced INSIDE a subagent carry the id of the Agent call that spawned it.
        where = f"  [inside subagent of {message.parent_tool_use_id}]" if message.parent_tool_use_id else ""
        for block in message.content:
            if isinstance(block, ToolUseBlock) and is_delegation(block.name):
                lines.append(
                    f"DELEGATE via {block.name!r} ({block.id}) -> {block.input.get('subagent_type')}: "
                    f"{block.input.get('description')}"
                )
            elif isinstance(block, ToolUseBlock):
                lines.append(f"tool call {block.name}{where}")
    elif isinstance(message, ResultMessage):
        lines.append(f"RESULT subtype={message.subtype} turns={message.num_turns}: {(message.result or '')[:300]}")
    return lines


def recorded_stream() -> list[Any]:
    """A short stream in the shape the SDK yields, for the offline replay."""
    return [
        AssistantMessage(
            model=lab.MODEL,
            content=[
                TextBlock(text="I'll research both sub-areas in parallel."),
                ToolUseBlock(id="toolu_A1", name="Agent", input={
                    "subagent_type": "web-researcher", "description": "Music licensing news",
                    "prompt": "Find 2026 news on AI music licensing deals ..."}),
                # Older Claude Code versions (and the exam) name the same tool "Task".
                ToolUseBlock(id="toolu_A2", name="Task", input={
                    "subagent_type": "doc-analyst", "description": "VFX workforce study",
                    "prompt": "From ./docs extract findings on generative AI adoption in VFX ..."}),
            ],
        ),
        AssistantMessage(
            model=lab.MODEL,
            parent_tool_use_id="toolu_A2",
            content=[ToolUseBlock(id="toolu_B1", name="Read", input={"file_path": "docs/screen_vfx_workforce_study_2026.md"})],
        ),
        ResultMessage(
            subtype="success", duration_ms=0, duration_api_ms=0, is_error=False, num_turns=6, session_id="offline",
            result="Briefing: 28% of VFX studios use generative AI [D2: Screen Industries VFX Workforce Study p.31] ...",
        ),
    ]


async def run_live(options: Any) -> list[str]:
    events: list[str] = []
    async for message in query(prompt=TOPIC, options=options):
        for line in describe_message(message):
            print(f"  {line}")
            events.append(line)
    return events


def main() -> None:
    lab.banner("D1.3  Coordinator with AgentDefinitions (Claude Agent SDK)")
    options = build_options()

    lab.section("Coordinator options")
    print(f"allowed_tools:    {options.allowed_tools}")
    print(f"disallowed_tools: {options.disallowed_tools}")
    print(f"model: {options.model}   cwd: fixtures/   max_turns: {options.max_turns}")
    print("system_prompt (goals + quality criteria, no procedure):")
    print("  " + COORDINATOR_PROMPT.replace("\n", "\n  "))

    lab.section("Subagent definitions")
    for name, agent in options.agents.items():
        print(f"{name}: tools={agent.tools} model={agent.model}")
        print(f"  description: {agent.description}")
        print(f"  prompt:      {agent.prompt[:100]}...")

    agents = options.agents
    lab.check("Agent" in options.allowed_tools, "allowed_tools includes 'Agent' (the exam's 'Task'), so the coordinator can spawn subagents")
    lab.check(all(a.description and a.prompt and a.tools and a.model == "inherit" for a in agents.values()),
              "every AgentDefinition has a description, its own prompt, a tool list and model='inherit'")
    lab.check(not WEB_TOOLS & set(agents["synthesizer"].tools) and not WEB_TOOLS & set(agents["doc-analyst"].tools),
              "least privilege: only web-researcher can reach the web")
    lab.check("Quality criteria" in COORDINATOR_PROMPT and not steps_in(COORDINATOR_PROMPT),
              "coordinator prompt states goals and quality criteria, not step-by-step procedure")
    lab.check(len(steps_in(PROCEDURAL_PROMPT)) == 4, "the procedural anti-pattern prompt is flagged (4 hard-coded steps)")

    lab.section("Delegation events" + (" (live run)" if lab.is_live() else " (offline replay of a recorded stream)"))
    if lab.is_live():
        events = lab.run(run_live(options))
    else:
        events = [line for message in recorded_stream() for line in describe_message(message)]
        for line in events:
            print(f"  {line}")
        delegations = [e for e in events if e.startswith("DELEGATE")]
        lab.check(len(delegations) == 2 and "'Task'" in delegations[1], "delegations detected under both names, 'Agent' and 'Task'")
        lab.check(any("[inside subagent of toolu_A2]" in e for e in events), "parent_tool_use_id marks work done inside a subagent")
    lab.check(any(e.startswith("RESULT") for e in events), "the run ended with a ResultMessage")


if __name__ == "__main__":
    main()
