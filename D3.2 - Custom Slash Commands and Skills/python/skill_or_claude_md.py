"""D3.2 - Skill (on demand) or CLAUDE.md (always loaded)? An explicit decision helper.

    CLAUDE.md / .claude/rules   loaded into EVERY session; costs tokens on every task
                                -> universal standards Claude must follow no matter what it is doing
    skill / command             loaded only when invoked (by you, or by Claude when the description fits)
                                -> task-specific workflows with steps and an output format

Extra knobs once something is a skill:
    context: fork        the skill produces verbose or exploratory output -> isolate it in a subagent
    allowed-tools        pre-approve exactly the tools the workflow needs (Read Write for scaffolding)
    disable-model-invocation: true   side effects -> only a human starts it

Run:  python skill_or_claude_md.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402


@dataclass
class Guidance:
    text: str
    applies_to_every_task: bool  # would you want Claude to follow it whatever the current task is?
    file_globs: list[str] = field(default_factory=list)  # only relevant for some files (-> path rule)
    verbose_or_exploratory: bool = False  # lots of intermediate output the main session doesn't need
    side_effects: bool = False  # writes files or runs commands
    read_only: bool = False


@dataclass
class Decision:
    where: str
    frontmatter: dict[str, object]
    reasons: list[str]


def decide(g: Guidance) -> Decision:
    if g.applies_to_every_task and g.file_globs:
        return Decision(
            ".claude/rules/<topic>.md with paths:",
            {"paths": g.file_globs},
            ["always applies, but only to some files: a path-scoped rule loads it exactly then (D3.3)"],
        )
    if g.applies_to_every_task:
        return Decision("CLAUDE.md", {}, ["universal standard: must be in context for every task, so always load it"])
    reasons = ["task-specific workflow: load it only when someone runs it, not in every session"]
    front: dict[str, object] = {}
    if g.verbose_or_exploratory:
        front["context"] = "fork"
        reasons.append("verbose/exploratory output: context: fork keeps it out of the main conversation")
        if g.read_only:
            front["agent"] = "Explore"
            reasons.append("read-only discovery: run it on the Explore subagent")
    if g.read_only:
        front["allowed-tools"] = "Read Grep Glob"
    elif g.side_effects:
        front["allowed-tools"] = "Read Write"
        front["disable-model-invocation"] = True
        reasons.append("side effects: pre-approve only what it needs, and let only a human trigger it")
    return Decision(".claude/skills/<name>/SKILL.md", front, reasons)


EXAMPLES: list[tuple[Guidance, str]] = [
    (Guidance("TypeScript strict mode everywhere; never use `any`", applies_to_every_task=True), "CLAUDE.md"),
    (Guidance("Use pnpm, never npm or yarn", applies_to_every_task=True), "CLAUDE.md"),
    (Guidance("Commit messages follow Conventional Commits", applies_to_every_task=True), "CLAUDE.md"),
    (
        Guidance("Test files use node:test and query the DOM with getByRole", applies_to_every_task=True, file_globs=["**/*.test.tsx", "**/*.test.ts"]),
        ".claude/rules/<topic>.md with paths:",
    ),
    (Guidance("Run the team review checklist on the current branch", applies_to_every_task=False, read_only=True), ".claude/skills/<name>/SKILL.md"),
    (
        Guidance("Map how the checkout module works before a refactor (reads dozens of files)", applies_to_every_task=False, verbose_or_exploratory=True, read_only=True),
        ".claude/skills/<name>/SKILL.md",
    ),
    (
        Guidance("Compare three designs for persisting the cart", applies_to_every_task=False, verbose_or_exploratory=True),
        ".claude/skills/<name>/SKILL.md",
    ),
    (Guidance("Scaffold a component with its test and CSS module", applies_to_every_task=False, side_effects=True), ".claude/skills/<name>/SKILL.md"),
]


def main() -> None:
    lab.banner("D3.2  Skill or CLAUDE.md? Deciding where guidance belongs")
    decisions = []
    for guidance, expected in EXAMPLES:
        decision = decide(guidance)
        decisions.append((guidance, decision, expected))
        extras = f"  {decision.frontmatter}" if decision.frontmatter else ""
        print(f"\n  {guidance.text}\n    -> {decision.where}{extras}")
        for reason in decision.reasons:
            print(f"       - {reason}")

    lab.section("Checks")
    lab.check(all(d.where == expected for _, d, expected in decisions), "every example lands where the exam expects")
    by_text = {g.text: d for g, d, _ in decisions}
    lab.check(by_text["Map how the checkout module works before a refactor (reads dozens of files)"].frontmatter.get("context") == "fork", "verbose codebase analysis -> skill with context: fork")
    lab.check(by_text["Compare three designs for persisting the cart"].frontmatter.get("context") == "fork", "exploratory brainstorming -> skill with context: fork")
    lab.check(by_text["Scaffold a component with its test and CSS module"].frontmatter.get("allowed-tools") == "Read Write", "scaffolding -> allowed-tools limited to file read/write")
    lab.check(by_text["Use pnpm, never npm or yarn"].where == "CLAUDE.md", "a convention every task must follow is never a skill: skills only load when invoked")


if __name__ == "__main__":
    main()
