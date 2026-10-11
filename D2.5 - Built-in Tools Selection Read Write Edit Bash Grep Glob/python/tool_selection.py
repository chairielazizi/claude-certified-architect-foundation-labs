"""D2.5 - Which built-in tool for which job, run against sample_repo/.

The rule of thumb the exam tests:
    searching file CONTENTS (callers, error messages, imports)  -> Grep
    finding files by NAME / PATH pattern (**/*.test.tsx)        -> Glob
    loading a whole file to understand it                       -> Read
    changing one uniquely identifiable piece of a file          -> Edit
    creating a file, or replacing a whole file                  -> Write
    running something (tests, git, build)                       -> Bash

``pick_builtin`` encodes that rule; each Grep/Glob/Read task is then executed with the
mini tools so you can see why that tool fits.

Always offline. Run:  python tool_selection.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from mini_tools import Workspace  # noqa: E402

SAMPLE_REPO = Path(__file__).resolve().parents[1] / "sample_repo"

# Ordered: the first rule whose pattern matches the task wins.
RULES: list[tuple[str, str, str]] = [
    ("Bash", r"\b(run|execute|install|git|build)\b", "executes commands"),
    ("Glob", r"\b(files? (named|matching|ending)|file names?|by name|\*\*/)", "matches file PATHS by pattern"),
    ("Grep", r"\b(callers?|calls?|usages?|uses|where .* (raised|defined|logged)|imports?|error message|containing)\b", "searches file CONTENTS"),
    ("Write", r"\b(create|new file|rewrite|replace the whole)\b", "creates / fully replaces a file"),
    ("Edit", r"\b(change|rename|bump|fix)\b", "targeted change at a unique anchor"),
    ("Read", r"\b(understand|read|review|explain)\b", "loads full contents"),
]

# (task, expected tool, how to run it in the sample repo or None)
TASKS: list[tuple[str, str, tuple[str, str] | None]] = [
    ("Find all callers of charge()", "Grep", ("grep", r"\bcharge\(")),
    ("Find test files matching **/*.test.tsx", "Glob", ("glob", "**/*.test.tsx")),
    ("Find where the error message 'Refund window expired' is raised", "Grep", ("grep", r"Refund window expired")),
    ("Find Python test files named test_*.py anywhere", "Glob", ("glob", "**/test_*.py")),
    ("Find every module that imports from app.payments", "Grep", ("grep", r"from app\.payments import")),
    ("Understand the checkout flow in app/checkout.py", "Read", ("read", "app/checkout.py")),
    ("Bump the refund window_days from 30 to 45", "Edit", None),
    ("Create a new file tests/test_reconcile.py", "Write", None),
    ("Run the test suite", "Bash", None),
]


def pick_builtin(task: str) -> tuple[str, str]:
    for tool, pattern, why in RULES:
        if re.search(pattern, task, re.I):
            return tool, why
    return "Read", "default: look before acting"


def main() -> None:
    lab.banner("D2.5  Choosing between Read, Write, Edit, Bash, Grep and Glob")
    ws = Workspace(SAMPLE_REPO)
    print(f"sample repo: {len(ws.all_files())} files")

    lab.section("Tool selection table")
    choices = {}
    for task, expected, _ in TASKS:
        tool, why = pick_builtin(task)
        choices[task] = tool
        print(f"  {task:<64} -> {tool:<5} ({why})")

    lab.section("Running the Grep / Glob / Read tasks")
    outputs = {}
    for task, _, action in TASKS:
        if action is None:
            continue
        kind, arg = action
        if kind == "grep":
            result = [f"{p}:{n}" for p, n, _ in ws.grep(arg)]
        elif kind == "glob":
            result = ws.glob(arg)
        else:
            result = [f"{len(ws.read(arg).splitlines())} lines of {arg}"]
        outputs[task] = result
        print(f"  {choices[task]} '{arg}': {result}")

    lab.section("Checks")
    lab.check(all(choices[t] == e for t, e, _ in TASKS), "every task maps to the expected built-in tool")
    tsx = outputs["Find test files matching **/*.test.tsx"]
    lab.check(len(tsx) == 2 and len({Path(p).parent for p in tsx}) == 2, "Glob finds *.test.tsx spread across directories (components/ and pages/)")
    py_tests = outputs["Find Python test files named test_*.py anywhere"]
    lab.check({"tests/test_checkout.py", "app/payments/test_stripe_adapter.py"} <= set(py_tests), "Glob ** reaches test files next to the code and in tests/")
    lab.check(outputs["Find where the error message 'Refund window expired' is raised"][0].startswith("app/core.py"), "Grep locates the error message at its source (app/core.py)")
    lab.check(any(p.startswith("app/checkout.py") for p in outputs["Find all callers of charge()"]), "Grep finds the charge() call in checkout.py")


if __name__ == "__main__":
    main()
