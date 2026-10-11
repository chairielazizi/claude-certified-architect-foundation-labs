"""D3.4 - Plan mode for investigation, direct execution for implementation (Claude Agent SDK).

    phase 1  permission_mode="plan"         read-only: explore, compare approaches, return a plan
             + read-only explorer subagent  verbose discovery happens in ITS context; a summary returns
    (a human approves the plan)
    phase 2  permission_mode="acceptEdits"  execute the APPROVED plan, injected verbatim into the prompt

The task is a small library migration on sample-repo/ (replace common/legacy_dates.py with the
standard library). Every run works on a fresh copy under .lab-runtime/workspace, never on sample-repo.

Run:  python plan_then_execute.py          offline: real SDK option objects + a scripted plan -> execute handoff
      python plan_then_execute.py --live   real query() calls (needs the Claude Code runtime + credentials)
"""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

LAB = Path(__file__).resolve().parents[1]
SAMPLE_REPO = LAB / "sample-repo"
WORKSPACE = LAB / ".lab-runtime" / "workspace"
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"}

TASK = (
    "Replace every use of common/legacy_dates.py with the standard library (date.fromisoformat, "
    "date.isoformat, plain date subtraction), then delete common/legacy_dates.py. Behavior must not "
    "change: tests/test_callers.py must still pass."
)

# A custom read-only explorer. In interactive Claude Code the built-in "Explore" subagent plays this
# role without any definition; in the SDK you can define your own and pin its tools to read-only.
EXPLORER = AgentDefinition(
    description=(
        "Read-only dependency explorer. Use it for verbose discovery: finding every caller of a module "
        "and how each one uses it."
    ),
    prompt=(
        "You map how a module is used across a codebase. Grep for imports and call sites, Read only the "
        "lines you need, and return a compact summary: one line per caller file listing the helpers it "
        "uses and anything unusual. Never paste whole files."
    ),
    tools=["Read", "Grep", "Glob"],
    model="inherit",
)


def planning_prompt(task: str) -> str:
    return (
        f"{task}\n\nThis is the planning phase. Use the dependency-explorer subagent for discovery so raw "
        "search output stays out of this conversation. Then propose a plan: the approach you chose and why "
        "(name at least one alternative you rejected), every file to change under a '## Files' heading, "
        "and how to verify. Do not edit anything."
    )


def planning_options(workspace: Path) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        cwd=str(workspace),
        permission_mode="plan",  # Claude can read and design, but cannot modify files
        allowed_tools=["Read", "Grep", "Glob", "Agent"],  # "Agent" spawns subagents (formerly "Task")
        disallowed_tools=sorted(WRITE_TOOLS),  # belt and braces on top of plan mode
        agents={"dependency-explorer": EXPLORER},
        setting_sources=["project"],  # load sample-repo/CLAUDE.md (it names the deprecated module)
        max_turns=30,
    )


def execution_prompt(plan: str) -> str:
    return (
        "Execute this approved plan. Follow it step by step; do not re-plan or widen the scope. If a step "
        "turns out to be wrong, stop and report instead of improvising.\n\n"
        f"<approved_plan>\n{plan}\n</approved_plan>\n\n"
        "When you are done, run the tests and report the status of each step."
    )


def execution_options(workspace: Path) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        cwd=str(workspace),
        permission_mode="acceptEdits",  # direct execution: file edits are auto-approved
        allowed_tools=["Read", "Grep", "Glob", "Edit", "Write", "Bash(python -m unittest *)", "Bash(rm common/legacy_dates.py)"],
        setting_sources=["project"],
        max_turns=40,
    )


@dataclass
class PhaseResult:
    text: str
    tools_used: list[str] = field(default_factory=list)
    session_id: str | None = None
    edited: list[str] = field(default_factory=list)


async def run_live(prompt: str, options: ClaudeAgentOptions) -> PhaseResult:
    from claude_agent_sdk import AssistantMessage, ResultMessage, ToolUseBlock, query

    tools: list[str] = []
    plan_from_tool: str | None = None
    result_text, session_id = "", None
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    tools.append(block.name)
                    if block.name == "ExitPlanMode":  # plan mode presents its plan through this tool
                        plan_from_tool = str(block.input.get("plan", ""))
        elif isinstance(message, ResultMessage):
            result_text, session_id = message.result or "", message.session_id
    return PhaseResult(plan_from_tool or result_text, tools, session_id)


# ---------------------------------------------------------------------------
# Offline stand-in for query(): it behaves according to the permission mode it is given
# ---------------------------------------------------------------------------

IMPORT_RE = re.compile(r"^from common\.legacy_dates import (.+)\n", re.M)
REPLACEMENTS = {
    "parse_date": "date.fromisoformat(text)",
    "format_date": "value.isoformat()",
    "days_between": "(end - start).days",
}


def discover_callers(workspace: Path) -> dict[str, list[str]]:
    """What the explorer subagent reports: each caller file and the legacy helpers it imports."""
    callers = {}
    for path in sorted(workspace.rglob("*.py")):
        match = IMPORT_RE.search(path.read_text(encoding="utf-8"))
        if match:
            callers[path.relative_to(workspace).as_posix()] = [h.strip() for h in match.group(1).split(",")]
    return callers


def make_plan(callers: dict[str, list[str]]) -> str:
    steps = [
        f"{i}. {file}: " + "; ".join(f"{h} -> {REPLACEMENTS[h]}" for h in helpers)
        for i, (file, helpers) in enumerate(callers.items(), 1)
    ]
    return "\n".join(
        [
            "## Approach",
            "Migrate each caller directly to the standard library. Rejected alternative: keep legacy_dates.py",
            "as a thin shim over datetime - zero caller churn, but the deprecated module lives on forever.",
            "",
            "## Steps",
            *steps,
            f"{len(steps) + 1}. Delete common/legacy_dates.py",
            f"{len(steps) + 2}. Verify: python -m unittest discover -s tests -t .",
            "",
            "## Files",
            *[f"- {file}" for file in callers],
            "- common/legacy_dates.py (delete)",
        ]
    )


def planned_files(plan: str) -> list[str]:
    files_section = plan.split("## Files", 1)[1] if "## Files" in plan else ""
    return [line[2:].split(" ")[0] for line in files_section.splitlines() if line.startswith("- ")]


def migrate_source(source: str) -> str:
    source = re.sub(r"parse_date\(", "date.fromisoformat(", source)
    source = re.sub(r"format_date\(([^()]+)\)", r"\1.isoformat()", source)
    source = re.sub(r"days_between\(([^,]+), ([^)]+)\)", r"(\2 - \1).days", source)
    replacement = "from datetime import date\n" if "date.fromisoformat" in source else ""
    return IMPORT_RE.sub(replacement, source).lstrip("\n")


def scripted_run(prompt: str, options: ClaudeAgentOptions, workspace: Path) -> PhaseResult:
    if options.permission_mode == "plan":
        callers = discover_callers(workspace)  # read-only: Grep + Read, delegated to the explorer
        return PhaseResult(make_plan(callers), ["Agent", "ExitPlanMode"], "offline-plan-session")
    if options.permission_mode == "acceptEdits":
        match = re.search(r"<approved_plan>\n(.*?)\n</approved_plan>", prompt, re.S)
        if not match:
            return PhaseResult("No approved plan in the prompt; refusing to improvise a migration.", [], "offline-exec-session")
        edited = []
        for rel in planned_files(match.group(1)):
            path = workspace / rel
            if rel == "common/legacy_dates.py":
                path.unlink()
            else:
                path.write_text(migrate_source(path.read_text(encoding="utf-8")), encoding="utf-8", newline="\n")
            edited.append(rel)
        return PhaseResult(f"Executed the plan: {len(edited)} files changed; tests run.", ["Edit"] * (len(edited) - 1) + ["Bash", "Bash"], "offline-exec-session", edited)
    raise ValueError(f"unexpected permission_mode {options.permission_mode!r}")


async def run_phase(prompt: str, options: ClaudeAgentOptions, workspace: Path) -> PhaseResult:
    return await run_live(prompt, options) if lab.is_live() else scripted_run(prompt, options, workspace)


# ---------------------------------------------------------------------------


def fresh_workspace() -> Path:
    shutil.rmtree(WORKSPACE, ignore_errors=True)
    shutil.copytree(SAMPLE_REPO, WORKSPACE, ignore=shutil.ignore_patterns("__pycache__"))
    return WORKSPACE


def snapshot(workspace: Path) -> dict[str, str]:
    return {
        p.relative_to(workspace).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(workspace.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


def run_tests(workspace: Path) -> bool:
    """Run the sample repo's own unit tests in a subprocess (never in this process)."""
    proc = subprocess.run(
        [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-t", "."],
        cwd=workspace, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
    )
    return proc.returncode == 0


def describe(options: ClaudeAgentOptions) -> None:
    agents = {name: f"tools={a.tools} model={a.model}" for name, a in (options.agents or {}).items()}
    print("  ClaudeAgentOptions(")
    print(f"    permission_mode={options.permission_mode!r},")
    print(f"    allowed_tools={options.allowed_tools},")
    print(f"    disallowed_tools={options.disallowed_tools},")
    print(f"    agents={agents or {}},")
    print(f"    setting_sources={options.setting_sources}, max_turns={options.max_turns})")


def approve(plan: str) -> bool:
    if not lab.is_live():
        print("  [offline] the developer reviews the plan above and approves it")
        return True
    return input("Approve this plan and execute it? [y/N] ").strip().lower() == "y"


async def main_async() -> None:
    lab.banner("D3.4  Plan mode for investigation, then direct execution of the approved plan")
    workspace = fresh_workspace()
    lab.check(run_tests(workspace), "baseline: sample-repo tests pass before the migration")

    lab.section("Phase 1 - plan mode (read-only investigation)")
    plan_opts = planning_options(workspace)
    describe(plan_opts)
    before = snapshot(workspace)
    planning = await run_phase(planning_prompt(TASK), plan_opts, workspace)
    print(f"\nplan returned by phase 1 (tools used: {planning.tools_used}):\n")
    print("\n".join("    " + line for line in planning.text.splitlines()))
    lab.check(plan_opts.permission_mode == "plan", "phase 1 runs with permission_mode='plan'")
    lab.check(not WRITE_TOOLS & set(plan_opts.allowed_tools) and WRITE_TOOLS <= set(plan_opts.disallowed_tools), "phase 1 has no write tools: none allowed, all explicitly disallowed")
    lab.check(set(EXPLORER.tools or []) == {"Read", "Grep", "Glob"}, "the explorer subagent is read-only (Read, Grep, Glob)")
    lab.check(snapshot(workspace) == before, "planning changed nothing on disk")
    if not lab.is_live():
        lab.check(len(planned_files(planning.text)) == 5, "the plan names all 4 callers plus the module to delete")

    lab.section("Approval")
    if not approve(planning.text):
        print("  plan rejected; nothing was executed")
        return

    lab.section("Phase 2 - direct execution of the approved plan (acceptEdits)")
    exec_prompt = execution_prompt(planning.text)
    exec_opts = execution_options(workspace)
    describe(exec_opts)
    lab.check(exec_opts.permission_mode == "acceptEdits", "phase 2 runs with permission_mode='acceptEdits'")
    lab.check(planning.text in exec_prompt, "phase 2's prompt carries the approved plan verbatim")
    execution = await run_phase(exec_prompt, exec_opts, workspace)
    print(f"\nphase 2 result: {execution.text}")

    lab.section("Verify")
    leftovers = [p.relative_to(workspace).as_posix() for p in workspace.rglob("*.py") if "legacy_dates" in p.read_text(encoding="utf-8")]
    print(f"  files still referencing legacy_dates: {leftovers or 'none'}")
    lab.check(not leftovers and not (workspace / "common" / "legacy_dates.py").exists(), "no caller imports legacy_dates, and the module is gone")
    lab.check(run_tests(workspace), "sample-repo tests still pass after the migration")
    if not lab.is_live():
        lab.check(sorted(execution.edited) == sorted(planned_files(planning.text)), "execution touched exactly the files in the plan")
        refused = scripted_run("Just do the migration.", exec_opts, fresh_workspace())
        lab.check(not refused.edited and "No approved plan" in refused.text, "without an approved plan in the prompt, the executor does not improvise")


if __name__ == "__main__":
    lab.run(main_async())
