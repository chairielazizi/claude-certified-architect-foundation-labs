"""D3.2 - What Claude actually receives when you type `/name args`.

Placeholders in a command or skill body:

    $ARGUMENTS       everything you typed after the name
    $ARGUMENTS[N]    the N-th argument, 0-based
    $0, $1, ...      shorthand for $ARGUMENTS[0], $ARGUMENTS[1] (0-BASED: $0 is the first argument)
    $issue           a named argument, declared with `arguments: [issue, branch]`
    \\$5             a literal dollar sign
    !`git diff ...`  shell injection: Claude Code runs the command first and pastes its output

Arguments are split with shell-style quoting, so "feat/cart totals" is one argument. If no placeholder
receives the arguments, Claude Code appends `ARGUMENTS: <input>` so they are never silently dropped.

Run:  python invoke_skill.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from skill_inspector import EXAMPLE_REPO, USER_HOME, Entry, discover, fresh_copy, render, resolve_names, write_tree  # noqa: E402

FIX_ISSUE = """---
name: fix-issue
description: Fix a tracked issue on a given branch
argument-hint: "[issue-number] [branch]"
arguments: [issue, branch]
---
Fix issue #$issue on branch `$branch`.
Same values by position: $ARGUMENTS[0] / $1 (0-based, so $1 is the SECOND argument).
Escaped dollar stays literal: the fix must not change the \\$5 shipping fee.
"""

EXPLAIN_ERROR = """---
name: explain-error
description: Explain an error message and the most likely cause in this codebase
---
Explain the error below in plain language, then point to the most likely cause in this repository.
"""


def show_invocation(entry: Entry, raw: str) -> None:
    result = render(entry, raw)
    print(f"\n> {entry.slash} {raw}".rstrip())
    if result.prompt is None:
        print(f"  (not sent to Claude) {result.ask_user}")
        return
    print(f"  args: {result.args}")
    if result.shell_commands:
        print(f"  shell injection ran first: {result.shell_commands}")
    print("  prompt Claude receives:")
    print("\n".join("    | " + line for line in result.prompt.strip().splitlines()))


def main() -> None:
    lab.banner("D3.2  Invoking commands and skills: argument substitution and argument-hint")
    slots = resolve_names(discover(EXAMPLE_REPO, USER_HOME))
    scaffold = slots["scaffold-component"].winner
    review = slots["review"].winner

    lab.section("1. Positional arguments are 0-based")
    show_invocation(scaffold, "CartSummary src/components")
    full = render(scaffold, "CartSummary src/components")
    assert full.prompt is not None
    lab.check("Create the React component `CartSummary` in `src/components`" in full.prompt, "$0 -> first argument, $1 -> second argument")
    lab.check("interface CartSummaryProps" in full.prompt, "$0Props expands to CartSummaryProps (placeholder followed by text)")
    lab.check("$0" not in full.prompt and "$1" not in full.prompt, "no placeholder left unexpanded")

    lab.section("2. argument-hint prompts for missing required arguments")
    show_invocation(scaffold, "")
    show_invocation(scaffold, "CartSummary")
    none_given, one_given = render(scaffold, ""), render(scaffold, "CartSummary")
    lab.check(none_given.prompt is None and "[ComponentName] [directory]" in str(none_given.ask_user), "no arguments -> the developer sees the hint instead of a half-empty prompt")
    lab.check(one_given.prompt is None, "one of two required arguments -> still asks")

    lab.section("3. $ARGUMENTS plus !`shell` injection (/review)")
    show_invocation(review, "security of the new cart endpoint")
    focused = render(review, "security of the new cart endpoint")
    assert focused.prompt is not None
    lab.check(focused.shell_commands == ["git diff --stat main...HEAD"], "the !`git diff --stat main...HEAD` line is a shell injection")
    lab.check("3 files changed" in focused.prompt and "!`" not in focused.prompt, "its output replaces the line before Claude sees the prompt")
    lab.check("security of the new cart endpoint" in focused.prompt, "$ARGUMENTS carries the whole focus phrase")
    lab.check(render(review, "").prompt is not None, "the focus is optional ('[optional focus ...]'), so bare /review still runs")

    lab.section("4. Named arguments, $ARGUMENTS[N], quoting and \\$ (generated skills)")
    repo, home = fresh_copy("invoke")
    write_tree(repo, {".claude/skills/fix-issue/SKILL.md": FIX_ISSUE, ".claude/skills/explain-error/SKILL.md": EXPLAIN_ERROR})
    generated = resolve_names(discover(repo, home))
    fix = generated["fix-issue"].winner
    show_invocation(fix, '1234 "feat/cart totals"')
    named = render(fix, '1234 "feat/cart totals"')
    assert named.prompt is not None
    lab.check(named.args == ["1234", "feat/cart totals"], 'shell-style quoting: "feat/cart totals" is ONE argument')
    lab.check("Fix issue #1234 on branch `feat/cart totals`" in named.prompt, "named arguments: $issue and $branch")
    lab.check("1234 / feat/cart totals" in named.prompt, "$ARGUMENTS[0] and $1 index the same 0-based list")
    lab.check("\\$5" not in named.prompt and "$5 shipping fee" in named.prompt, "\\$5 renders as a literal $5")

    lab.section("5. Arguments are never dropped")
    explain = generated["explain-error"].winner
    show_invocation(explain, "TypeError: cannot read properties of undefined (reading 'total')")
    appended = render(explain, "TypeError: cannot read properties of undefined (reading 'total')")
    assert appended.prompt is not None
    lab.check(
        appended.prompt.rstrip().endswith("ARGUMENTS: TypeError: cannot read properties of undefined (reading 'total')"),
        "no placeholder in the body -> 'ARGUMENTS: <input>' is appended",
    )


if __name__ == "__main__":
    main()
