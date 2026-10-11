"""D3.1 - Diagnose a configuration-hierarchy bug: "Claude keeps running npm for the new hire".

The lead developer wrote "Use pnpm, never npm" in THEIR ~/.claude/CLAUDE.md. It works perfectly for
the lead, so nobody notices that the instruction is not in version control. A new teammate clones
the repo, Claude runs `npm install`, and a second lockfile appears.

The diagnosis is mechanical: resolve both developers' memory (what /memory shows each of them),
find which file provides the instruction, and look at its scope. User scope = only that person.
The fix is to move the team convention into the project CLAUDE.md, which git shares.

Run:  python diagnose_teammate.py
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from memory_resolver import EXAMPLE_REPO, LEAD_HOME, RUNTIME, TEAMMATE_HOME, Resolution, resolve_memory  # noqa: E402

NEEDLE = "Use pnpm, never npm"
PROJECT_LINE = (
    "- Use pnpm, never npm or yarn (the version is pinned by `packageManager` in `package.json`). "
    "npm and yarn write a second lockfile and bypass the workspace."
)
SHARED_SCOPES = {"project", "rule", "subdir"}  # committed to git -> every clone gets them


def setup_workspace() -> dict[str, dict[str, Path]]:
    """Two developers, each with their own home directory and their own checkout of the same commit."""
    base = RUNTIME / "diagnose"
    shutil.rmtree(base, ignore_errors=True)
    people = {
        "lead": {"home": base / "lead" / "home", "repo": base / "lead" / "acme-shop"},
        "teammate": {"home": base / "teammate" / "home", "repo": base / "teammate" / "acme-shop"},
    }
    shutil.copytree(LEAD_HOME, people["lead"]["home"])
    shutil.copytree(TEAMMATE_HOME, people["teammate"]["home"])
    for person in people.values():
        shutil.copytree(EXAMPLE_REPO, person["repo"])
    # The lead also keeps a CLAUDE.local.md (gitignored): another file the teammate never receives.
    shutil.copy(people["lead"]["repo"] / "CLAUDE.local.md.example", people["lead"]["repo"] / "CLAUDE.local.md")
    return people


def sessions(people: dict[str, dict[str, Path]]) -> dict[str, Resolution]:
    return {name: resolve_memory(p["home"], p["repo"]) for name, p in people.items()}


def sources(res: Resolution, needle: str) -> list[str]:
    """Where an instruction comes from in one developer's session, as 'scope:path'."""
    return [f"{f.scope}:{res.display(f.path)}" for f in res.find(needle)]


def instruction_lines(res: Resolution) -> dict[str, str]:
    """Bullet-point instructions in a session, mapped to the scope:path that provides them."""
    found: dict[str, str] = {}
    for f in res.files:
        for line in f.text.splitlines():
            if line.lstrip().startswith("- "):
                found.setdefault(line.strip(), f"{f.scope}:{res.display(f.path)}")
    return found


def move_to_project(people: dict[str, dict[str, Path]]) -> None:
    """The fix: delete the line from the lead's user memory and commit it to the project CLAUDE.md."""
    user_md = people["lead"]["home"] / ".claude" / "CLAUDE.md"
    kept = [line for line in user_md.read_text(encoding="utf-8").splitlines() if NEEDLE not in line]
    user_md.write_text("\n".join(kept) + "\n", encoding="utf-8", newline="\n")
    for person in people.values():  # commit + `git pull`: every checkout gets the same project file
        project_md = person["repo"] / "CLAUDE.md"
        text = project_md.read_text(encoding="utf-8")
        project_md.write_text(text.replace("## Tooling\n\n", f"## Tooling\n\n{PROJECT_LINE}\n", 1), encoding="utf-8", newline="\n")


def main() -> None:
    lab.banner("D3.1  Diagnose: the new teammate never got 'use pnpm, never npm'")
    people = setup_workspace()

    lab.section("Symptom: same repo, same commit, different behavior")
    before = sessions(people)
    for name, res in before.items():
        print(f"\n/memory for {name}:")
        print(res.listing())

    lab.section("Diagnosis: where does each session get the instruction?")
    for name, res in before.items():
        print(f"  {name:<9} {NEEDLE!r:<24} -> {sources(res, NEEDLE) or 'MISSING'}")
    lead_lines, mate_lines = instruction_lines(before["lead"]), instruction_lines(before["teammate"])
    lead_only = {line: src for line, src in lead_lines.items() if line not in mate_lines}
    print("\n  Instructions only the lead's sessions receive (and why):")
    for line, src in lead_only.items():
        print(f"    [{src.split(':')[0]}] {line[:88]}")
    leaked = [src for line, src in lead_only.items() if NEEDLE in line]
    print(f"\n  -> {NEEDLE!r} is a TEAM convention stored in {leaked[0]}, which is not in version control.")
    lab.check(bool(sources(before["lead"], NEEDLE)), "the lead's session has the instruction")
    lab.check(not sources(before["teammate"], NEEDLE), "the teammate's session does not (this is the bug)")
    lab.check(leaked == ["user:~/.claude/CLAUDE.md"], "root cause: it lives in user scope (~/.claude/CLAUDE.md)")
    lab.check(
        all(src.split(":")[0] not in SHARED_SCOPES for src in lead_only.values()),
        "every lead-only instruction comes from user or local scope; nothing committed differs",
    )

    lab.section("Fix: move the convention into the project CLAUDE.md (committed)")
    move_to_project(people)
    print(f"  removed from lead's ~/.claude/CLAUDE.md; added under '## Tooling' in ./CLAUDE.md:\n    {PROJECT_LINE}")
    after = sessions(people)
    for name, res in after.items():
        print(f"  {name:<9} {NEEDLE!r:<24} -> {sources(res, NEEDLE)}")
    lab.check(
        all(sources(res, NEEDLE) == ["project:./CLAUDE.md"] for res in after.values()),
        "both developers now get it, from exactly one place: the project CLAUDE.md",
    )
    lab.check(
        "Prefer `rg`" in after["lead"].all_text()
        and "Prefer `rg`" not in after["teammate"].all_text()
        and "two-line summary" not in after["lead"].all_text(),
        "personal preferences stay personal: each developer still gets only their own ~/.claude/CLAUDE.md",
    )
    print("\nIn Claude Code, each developer runs /memory: the pnpm line should now show under the project file.")


if __name__ == "__main__":
    main()
