"""D5.4 - Delegate verbose exploration to subagents; inject phase summaries into the next phase.

Part 1. The main agent needs two answers: "find all test files" and "trace refund flow dependencies".
    A  inline     the main agent explores itself; every file it reads stays in ITS context
    B  delegated  the main agent spawns two subagents in one turn (each starts with a fresh
                  context, so the task prompt carries everything it needs) and keeps only
                  their concise summaries for high-level coordination

Part 2. Phase 2 ("propose missing tests for the refund window") is spawned twice: with the
phase-1 key findings injected into its initial prompt, and without them.

Run:  python subagent_delegation.py          (offline)
      python subagent_delegation.py --live   (real API; repo tools stay local and read-only)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from explorer import (  # noqa: E402
    ANALYST_PROMPT,
    EXPLORER_PROMPT,
    EXPLORER_TOOLS,
    Executor,
    exchanges,
    execute,
    run_agent,
    scripted_model,
)

COORDINATOR_PROMPT = (
    "You coordinate codebase exploration. Delegate verbose discovery to subagents with spawn_subagent "
    "(several in one turn when they are independent) and keep only their summaries. Subagents start with "
    "a fresh context: put everything they need in the task."
)
SPAWN_TOOL: dict[str, Any] = {
    "name": "spawn_subagent",
    "description": "Start a read-only explorer subagent (glob, grep, read_file) with a fresh context. Returns its concise summary.",
    "input_schema": {"type": "object", "properties": {"task": {"type": "string"}}, "required": ["task"]},
}
MAIN_QUESTION = "Map the refund path: which test files exist and how does a refund flow through the code?"
INLINE_TASK = "Find all test files, then trace refund flow dependencies starting from post_refund. Report both."
SUBTASKS = [
    "Find all test files under tests/ and summarize what each one covers.",
    "Trace refund flow dependencies starting from the HTTP handler post_refund.",
]
PHASE2_TASK = "Propose missing test cases for the refund-window rule."


def scripted_coordinator(params: dict[str, Any]) -> lab.Obj:
    seen = exchanges(params)
    if not seen:  # two independent investigations -> two spawns in ONE turn (parallel)
        return lab.message(lab.text("Delegating both investigations."), *[lab.tool_use("spawn_subagent", {"task": t}) for t in SUBTASKS])
    return lab.message(lab.text("\n\n".join(content for _, _, content in seen)))


def responder(params: dict[str, Any]) -> lab.Obj:
    if lab.system_text(params).startswith(COORDINATOR_PROMPT):
        return scripted_coordinator(params)
    return scripted_model(params)


def spawn_executor(client: Any, log: list[dict[str, Any]]) -> Executor:
    def executor(name: str, args: dict[str, Any]) -> tuple[str, bool]:
        if name != "spawn_subagent":
            return execute(name, args)
        sub = run_agent(client, EXPLORER_PROMPT, args["task"], EXPLORER_TOOLS)  # fresh context, no parent history
        log.append({"task": args["task"], "calls": len(sub["calls"]), "tool_chars": sub["tool_chars"], "summary_chars": len(sub["answer"])})
        return sub["answer"], False

    return executor


def main() -> None:
    lab.banner("D5.4  Subagent delegation and phase summaries")
    client = lab.get_client(responder)

    lab.section("Part 1A - inline: the main agent explores everything itself")
    inline = run_agent(client, EXPLORER_PROMPT, INLINE_TASK, EXPLORER_TOOLS)
    print(f"main agent: {len(inline['calls'])} tool calls, {inline['tool_chars']:,} chars of tool output in the MAIN context")

    lab.section("Part 1B - delegated: two subagents, summaries only")
    log: list[dict[str, Any]] = []
    delegated = run_agent(client, COORDINATOR_PROMPT, MAIN_QUESTION, [SPAWN_TOOL], spawn_executor(client, log))
    for entry in log:
        print(f"  subagent: {entry['task']}\n    {entry['calls']} tool calls, {entry['tool_chars']:,} chars stayed in the subagent; returned {entry['summary_chars']:,} chars")
    print(f"main agent: {delegated['calls']}, {delegated['tool_chars']:,} chars in the MAIN context")
    saved = 100 - delegated["tool_chars"] * 100 // inline["tool_chars"]
    print(f"main-context saving: {saved}%")

    lab.section("Part 2 - phase 2 with and without the phase-1 summary")
    key_findings = [line for line in delegated["answer"].split("\n") if line.startswith("- ")]
    phase1_summary = "Phase 1 key findings:\n" + "\n".join(key_findings)
    print(f"phase-1 summary injected into the phase-2 prompt: {len(phase1_summary):,} chars")
    with_summary = run_agent(client, ANALYST_PROMPT, f"{phase1_summary}\n\nTask: {PHASE2_TASK}", EXPLORER_TOOLS)
    without = run_agent(client, ANALYST_PROMPT, f"Task: {PHASE2_TASK}", EXPLORER_TOOLS)
    print(f"  with summary:    tools {with_summary['calls']}")
    print(f"  without summary: tools {without['calls']}")
    print("phase-2 answer:\n  " + with_summary["answer"].replace("\n", "\n  "))

    lab.section("Checks")
    first_turn = lab.tool_uses(lab.Obj(content=delegated["messages"][1]["content"]))
    lab.check(
        delegated["calls"] == ["spawn_subagent", "spawn_subagent"] and len(first_turn) == 2,
        "the coordinator spawned both subagents in ONE assistant turn (parallel)",
    )
    if lab.is_live():
        print("  live run: remaining checks depend on the model's choices; skipped")
        return
    for marker in ("ReturnEligibilityGate", "tests/policies/test_eligibility_gate.py"):
        lab.check(marker in inline["answer"] and marker in delegated["answer"], f"both approaches surfaced {marker}")
    lab.check(saved >= 60, "delegation kept the verbose file contents out of the main context (>= 60% smaller)")
    lab.check(
        with_summary["calls"] == ["read_file", "read_file"],
        "phase 2 with the injected summary went straight to the two relevant files",
    )
    lab.check(
        "grep" in without["calls"] and "glob" in without["calls"] and len(without["calls"]) >= 5,
        "phase 2 without it had to rediscover the code with grep and glob first",
    )
    lab.check(with_summary["answer"] == without["answer"], "same proposals either way; the summary only removed rework")


if __name__ == "__main__":
    main()
