"""D3.1 - Split a monolithic CLAUDE.md into focused topic files under .claude/rules/.

One 300-line CLAUDE.md has no owners: the testing section, the API section and the deployment section
are edited by different people and conflict constantly. `.claude/rules/` lets each topic live in its
own file (testing.md, api-conventions.md, deployment.md) that a team can own and review separately.

Rules WITHOUT `paths:` frontmatter still load at launch, exactly like CLAUDE.md, so this split changes
organization, not what Claude sees. Making a rule conditional (`paths:`) is what saves tokens; see D3.3.

Run:  python split_claude_md.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from memory_resolver import EXAMPLE_REPO, LAB, RUNTIME, resolve_memory, write_tree  # noqa: E402

MONOLITH = LAB / "fixtures" / "CLAUDE.monolithic.md"
# Which `## heading` goes to which rule file. The maintainer decides the topics; the tool just moves text.
TOPIC_FILES = {"Testing": "testing.md", "API conventions": "api-conventions.md", "Deployment": "deployment.md"}


def split_by_headings(text: str, topics: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Move each `## <topic>` section into its own rule file; everything else stays in CLAUDE.md."""
    keep: list[str] = []
    rules: dict[str, str] = {}
    for section in re.split(r"(?m)^(?=## )", text):
        heading = re.match(r"## (.+)\n", section)
        title = heading.group(1).strip() if heading else ""
        if heading and title in topics:
            rules[topics[title]] = f"# {title}\n\n{section[heading.end():].strip()}\n"
        else:
            keep.append(section)
    pointer = ", ".join(f"`{name}`" for name in rules)
    remaining = "".join(keep).rstrip() + f"\n\nTopic rules live in `.claude/rules/`: {pointer}.\n"
    return remaining, rules


def normalized(text: str) -> str:
    return "\n".join(line.rstrip() for line in text.strip().splitlines())


def instruction_lines(text: str) -> list[str]:
    """Every non-heading, non-blank line: the actual instructions that must survive the split."""
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def main() -> None:
    lab.banner("D3.1  Split a monolithic CLAUDE.md into .claude/rules/ topic files")
    monolith = MONOLITH.read_text(encoding="utf-8")
    remaining, rules = split_by_headings(monolith, TOPIC_FILES)

    files = {"home/.keep": "", "repo/CLAUDE.md": remaining}
    files |= {f"repo/.claude/rules/{name}": body for name, body in rules.items()}
    out = write_tree(RUNTIME / "split", files)

    lab.section("Before / after")
    print(f"  before: CLAUDE.md                {len(monolith.splitlines()):>3} lines (one file, no owners)")
    print(f"  after:  CLAUDE.md                {len(remaining.splitlines()):>3} lines")
    for name, body in rules.items():
        print(f"          .claude/rules/{name:<18}{len(body.splitlines()):>3} lines")
    print(f"  written to {out.relative_to(LAB).as_posix()}/repo")

    lab.section("What Claude loads after the split")
    split_res = resolve_memory(out / "home", out / "repo")
    print(split_res.listing())

    lab.check(sorted(rules) == sorted(TOPIC_FILES.values()), "testing.md, api-conventions.md, deployment.md were created")
    loaded = split_res.all_text()
    missing = [line for line in instruction_lines(monolith) if line not in loaded]
    lab.check(not missing, "every instruction line from the monolith still loads at launch (nothing lost)")
    committed = {p.name: p.read_text(encoding="utf-8") for p in (EXAMPLE_REPO / ".claude" / "rules").glob("*.md")}
    lab.check(
        all(normalized(rules[name]) == normalized(committed.get(name, "")) for name in rules),
        "the split output matches example-repo/.claude/rules/ exactly (that layout IS this split)",
    )
    before_tokens, after_tokens = len(monolith) // 4, split_res.total_tokens()
    print(f"\n  tokens at launch: monolith ~{before_tokens}, split ~{after_tokens}")
    lab.check(
        abs(after_tokens - before_tokens) <= before_tokens * 0.1,
        "rules without paths load at launch too: splitting reorganizes, it does not save tokens (D3.3 does)",
    )


if __name__ == "__main__":
    main()
