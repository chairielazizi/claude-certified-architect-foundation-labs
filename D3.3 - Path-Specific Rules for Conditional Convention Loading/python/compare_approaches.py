"""D3.3 - Three ways to deliver the same conventions, compared on the same repo.

    A. monolithic CLAUDE.md   every convention in one file; all of it loads in every session
    B. path-scoped rules      general.md always + only the rules whose globs match touched files
    C. directory CLAUDE.md    a CLAUDE.md per directory; loads when Claude works in that directory

C looks tidy until a convention is cross-cutting. Test files live next to the code they test, so the
test conventions have no single directory to live in: C must copy them into every directory tree that
has tests, they then also load for non-test files there, and a test in a NEW directory gets nothing.

Run:  python compare_approaches.py
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from glob_match import glob_match  # noqa: E402
from rule_loader import EXAMPLE_REPO, RUNTIME, SESSIONS, Rule, load_rules, repo_files, rules_for, tokens  # noqa: E402

TEST_MARKER = "# Test conventions"  # first heading of tests.md: tells us whether test rules are in context
NEW_TEST_FILE = "src/hooks/useCart.test.ts"  # a test in a directory that did not exist when C was set up


def body(rule: Rule) -> str:
    """Rule text without frontmatter (a monolithic or directory CLAUDE.md has no paths:)."""
    return re.sub(r"\A---\n.*?\n---\n", "", rule.text, flags=re.S).strip() + "\n"


def static_prefix(glob: str) -> str:
    """Leading path segments with no wildcard: 'src/api/**/*' -> 'src/api'; '**/*.test.ts' -> ''."""
    prefix = []
    for segment in glob.split("/")[:-1]:
        if any(ch in segment for ch in "*?[{"):
            break
        prefix.append(segment)
    return "/".join(prefix)


def topmost(dirs: set[str]) -> list[str]:
    """Drop directories nested inside another one (a CLAUDE.md there already covers the subtree)."""
    return sorted(d for d in dirs if not any(d != o and d.startswith(o + "/") for o in dirs))


def directory_layout(rules: list[Rule], files: list[str]) -> dict[str, list[Rule]]:
    """Where each rule would have to live if conventions could only be attached to directories."""
    layout: dict[str, list[Rule]] = {"": [r for r in rules if not r.conditional]}  # root CLAUDE.md
    for rule in (r for r in rules if r.conditional):
        homes: set[str] = set()
        for glob in rule.paths:
            prefix = static_prefix(glob)
            if prefix:
                homes.add(prefix)  # e.g. terraform/** has one natural home
            else:  # e.g. **/*.test.ts: every directory tree that has a matching file needs a copy
                homes |= set(topmost({f.rsplit("/", 1)[0] for f in files if "/" in f and glob_match(glob, f)}))
        for home in topmost(homes):
            layout.setdefault(home, []).append(rule)
    return layout


def load_directory_approach(layout: dict[str, list[Rule]], touched: list[str]) -> str:
    """Root CLAUDE.md + every directory CLAUDE.md between the root and each touched file."""
    dirs = {""}
    for file in touched:
        parts = file.split("/")[:-1]
        dirs |= {"/".join(parts[: i + 1]) for i in range(len(parts))}
    return "".join(body(rule) for d in sorted(dirs) if d in layout for rule in layout[d])


def main() -> None:
    lab.banner("D3.3  Monolithic CLAUDE.md vs path-scoped rules vs directory CLAUDE.md")
    rules = load_rules(EXAMPLE_REPO)
    files = repo_files(EXAMPLE_REPO)
    monolith = "".join(body(r) for r in rules)
    layout = directory_layout(rules, files)

    out = RUNTIME / "directory-claude-md"
    shutil.rmtree(out, ignore_errors=True)
    for directory, assigned in layout.items():
        target = out / directory / "CLAUDE.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("".join(body(r) for r in assigned), encoding="utf-8", newline="\n")

    lab.section("Approach C needs these directory CLAUDE.md files")
    for directory, assigned in sorted(layout.items()):
        print(f"  {(directory or '.') + '/CLAUDE.md':<28} {', '.join(r.name for r in assigned)}")
    test_copies = [d for d, assigned in layout.items() if any(r.name == "tests.md" for r in assigned)]
    print(f"  (written to {out.relative_to(RUNTIME.parent).as_posix()}/ so you can inspect them)")

    lab.section("Tokens in context per editing session")
    print(f"  {'session':<26}{'A monolith':>11}{'B rules':>9}{'C dirs':>8}   test rules loaded? (B / C)")
    rows = []
    for title, (touched, _) in SESSIONS.items():
        b_text = "".join(body(a.rule) for a in rules_for(rules, touched))
        c_text = load_directory_approach(layout, touched)
        rows.append((title, tokens(monolith), tokens(b_text), tokens(c_text)))
        is_test = any(t.endswith((".test.ts", ".test.tsx")) for t in touched)
        flag = f"{'yes' if TEST_MARKER in b_text else 'no'} / {'yes' if TEST_MARKER in c_text else 'no'}"
        print(f"  {title:<26}{tokens(monolith):>11}{tokens(b_text):>9}{tokens(c_text):>8}   {flag}{'' if is_test else '  (not a test file)'}")
    average_a = sum(r[1] for r in rows) / len(rows)
    average_b = sum(r[2] for r in rows) / len(rows)
    print(f"  {'average':<26}{average_a:>11.0f}{average_b:>9.0f}   -> path rules save {1 - average_b / average_a:.0%} vs the monolith")

    lab.section("Checks")
    lab.check(all(b < a for _, a, b, _ in rows), "path-scoped rules load less than the monolith in every session")
    lab.check(1 - average_b / average_a >= 0.4, "on average they cut convention tokens by at least 40%")
    lab.check(
        sorted(test_copies) == ["e2e", "src/api", "src/components", "src/lib"],
        f"directory CLAUDE.md needs the test conventions copied into {len(test_copies)} places; tests.md is ONE file",
    )
    component = ["src/components/Button.tsx"]
    lab.check(
        TEST_MARKER in load_directory_approach(layout, component)
        and TEST_MARKER not in "".join(a.rule.text for a in rules_for(rules, component)),
        "editing Button.tsx: directory CLAUDE.md drags in test rules anyway; the glob rule does not",
    )
    new = [NEW_TEST_FILE]
    lab.check(
        TEST_MARKER in "".join(a.rule.text for a in rules_for(rules, new))
        and TEST_MARKER not in load_directory_approach(layout, new),
        f"a new {NEW_TEST_FILE}: **/*.test.ts covers it automatically; no directory CLAUDE.md exists there",
    )


if __name__ == "__main__":
    main()
