"""D1.3 - The coordinator's ClaudeAgentOptions and its three subagent definitions.

Everything a subagent is lives in its AgentDefinition:
  description  - what the coordinator reads to decide WHEN to delegate to it
  prompt       - the subagent's system prompt (it gets nothing else from the parent)
  tools        - least-privilege tool list for that role
  model        - "inherit" = same model as the coordinator

The coordinator spawns subagents with the "Agent" tool. The exam guide calls it "Task": it was
renamed in Claude Code v2.1.63 and "Task" still works as an alias. Without it in allowed_tools
the coordinator cannot delegate at all.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

# The doc-analyst reads ./docs relative to this directory (the agent's cwd).
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

TOPIC = "How is generative AI changing music licensing and visual-effects work?"

# Names the spawning tool can appear under in a message stream.
DELEGATION_TOOL_NAMES = ("Agent", "Task")


def is_delegation(tool_name: str) -> bool:
    return tool_name in DELEGATION_TOOL_NAMES


# The sentence that tells the coordinator to fan out (parallel_spawning.py swaps it out).
PARALLEL_SENTENCE = "Independent research can run at the same time: issue those Agent calls together in one response."

# Goals and quality criteria, not a procedure: the coordinator decides HOW to meet them,
# so it can adapt (skip a source that has nothing, add a follow-up, run work in parallel).
COORDINATOR_PROMPT = f"""You lead a small research team and own the quality of its final briefing.

Research goal: a cited briefing on the user's topic that an analyst can rely on without re-checking.

Quality criteria:
- Every claim carries its source: a URL or a document name and page, plus a publication date.
- Coverage spans every major sub-area of the topic, not just the most visible one.
- Where sources disagree, report both figures with their sources instead of picking one.
- Separate well-established findings from contested or single-source ones.

Your team (spawn them with the Agent tool):
- web-researcher: current news and web sources.
- doc-analyst: the reports in ./docs.
- synthesizer: turns collected findings into the briefing.

Subagents start with an empty context: they cannot see this conversation or each other's work.
Put everything a subagent needs into its prompt, and give the synthesizer the complete findings as
JSON with content and source metadata in separate fields.
{PARALLEL_SENTENCE}"""

# Anti-pattern for comparison: a step list leaves the coordinator nothing to judge, and
# hard-codes one document even if the topic needs others.
PROCEDURAL_PROMPT = """Step 1: Ask web-researcher to search for the topic.
Step 2: Ask doc-analyst to read docs/music_rights_review_2026.md.
Step 3: Ask synthesizer to write a summary of what they said.
Step 4: Return the summary."""

FINDING_FORMAT = (
    "Return a JSON list of findings. Each item: "
    '{"finding_id": str, "content": {"claim": str, "evidence": str}, '
    '"metadata": {"source_url": str|null, "document_name": str|null, "page": int|null, "publication_date": str}}. '
    "Never return a claim without its source."
)

AGENT_SPECS: dict[str, dict[str, Any]] = {
    "web-researcher": {
        "description": (
            "Finds current news and web sources for one narrowly scoped research question. "
            "Use for recent deals, announcements and published statistics."
        ),
        "prompt": "You are a web researcher. Answer only the question in your task, using web search. " + FINDING_FORMAT,
        "tools": ["WebSearch", "WebFetch"],
    },
    "doc-analyst": {
        "description": (
            "Extracts findings, with page numbers, from the report library in ./docs. "
            "Use when a question can be answered from those reports."
        ),
        "prompt": "You are a document analyst. Read only the reports in ./docs that bear on your task. " + FINDING_FORMAT,
        "tools": ["Read", "Grep", "Glob"],
    },
    "synthesizer": {
        "description": (
            "Writes the cited briefing from findings passed to it. Does no research of its own: "
            "its prompt must contain the complete findings."
        ),
        "prompt": (
            "You are a research synthesizer. Work only from the findings in your prompt. Cite every claim with "
            "its finding_id and source. When findings conflict, keep both values side by side with their sources."
        ),
        # No web tools: it must not go off and re-research (least privilege, sample question 9).
        "tools": ["Read"],
    },
}


def steps_in(prompt: str) -> list[str]:
    """Numbered procedural steps in a prompt (used to lint coordinator prompts)."""
    return re.findall(r"(?im)^\s*step\s+\d+", prompt)


def build_options() -> Any:
    """ClaudeAgentOptions for the coordinator (imported lazily: offline demos print it)."""
    from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions

    agents = {
        name: AgentDefinition(description=spec["description"], prompt=spec["prompt"], tools=spec["tools"], model="inherit")
        for name, spec in AGENT_SPECS.items()
    }
    return ClaudeAgentOptions(
        system_prompt=COORDINATOR_PROMPT,
        agents=agents,
        # "Agent" lets the coordinator spawn subagents (exam: "Task"). The research tools are
        # pre-approved so the subagents that are ALLOWED them (per AgentDefinition.tools) are not
        # stopped by permission prompts. Nothing here can write or execute.
        allowed_tools=["Agent", "WebSearch", "WebFetch", "Read", "Grep", "Glob"],
        disallowed_tools=["Bash", "Write", "Edit"],
        model=lab.MODEL,
        cwd=str(FIXTURES),
        max_turns=40,
    )
