"""D2.1 - Review tool interfaces before the model ever sees them.

Runs the three static reviews from tool_lint.py over the "before" and "after"
toolsets and both system prompts:

  1. description linter   - is each description complete enough to choose by?
  2. overlap detector     - which pairs are near-identical (token Jaccard)?
  3. prompt keyword lint  - which instructions bind a keyword to a tool?

Always offline (no model involved). Run:  python lint_toolsets.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from tool_lint import OVERLAP_THRESHOLD, find_overlaps, lint_system_prompt, lint_toolset, max_similarity  # noqa: E402
from toolsets import BAD_TOOLS, GOOD_TOOLS, KEYWORD_TRAP_SYSTEM_PROMPT, RENAMES, REVIEWED_SYSTEM_PROMPT  # noqa: E402


def print_lint(label: str, report: dict[str, list[str]]) -> int:
    lab.section(label)
    total = 0
    for name, findings in report.items():
        print(f"  {name}: {'clean' if not findings else f'{len(findings)} finding(s)'}")
        for finding in findings:
            print(f"      - {finding}")
        total += len(findings)
    return total


def main() -> None:
    lab.banner("D2.1  Tool description, overlap and system-prompt review")

    bad_report = lint_toolset(BAD_TOOLS)
    good_report = lint_toolset(GOOD_TOOLS)
    bad_total = print_lint("1a. Description linter - BAD_TOOLS", bad_report)
    good_total = print_lint("1b. Description linter - GOOD_TOOLS", good_report)

    lab.section(f"2. Overlap detector (token Jaccard >= {OVERLAP_THRESHOLD})")
    bad_overlaps = find_overlaps(BAD_TOOLS)
    good_overlaps = find_overlaps(GOOD_TOOLS)
    print(f"  BAD_TOOLS  near-identical pairs: {bad_overlaps}")
    print(f"  GOOD_TOOLS near-identical pairs: {good_overlaps}  (max similarity {max_similarity(GOOD_TOOLS):.2f})")

    lab.section("Rename / split map (old tool <- new tool)")
    for new, old in RENAMES.items():
        if new != old:
            print(f"  {old:<17} <- {new}")

    lab.section("3. System-prompt keyword review")
    names = [t["name"] for t in GOOD_TOOLS]
    trap_findings = lint_system_prompt(KEYWORD_TRAP_SYSTEM_PROMPT, names)
    reviewed_findings = lint_system_prompt(REVIEWED_SYSTEM_PROMPT, names)
    print(f"  keyword-trap prompt: {KEYWORD_TRAP_SYSTEM_PROMPT!r}")
    for finding in trap_findings:
        print(f"      - {finding}")
    print(f"  reviewed prompt: {len(reviewed_findings)} finding(s)")

    lab.section("Checks")
    lab.check(all(bad_report[n] for n in ("get_customer", "lookup_order")), "minimal one-line descriptions are flagged")
    lab.check(
        any("generic name" in f for f in bad_report["analyze_document"]),
        "generic analyze_document is flagged for renaming / splitting",
    )
    lab.check(
        any({a, b} == {"analyze_content", "analyze_document"} for a, b, _ in bad_overlaps),
        "overlap detector catches analyze_content vs analyze_document",
    )
    lab.check(good_total == 0 and bad_total > 0, f"GOOD_TOOLS lint clean ({bad_total} findings before, {good_total} after)")
    lab.check(not good_overlaps, "no near-identical description pair remains after rename + split")
    lab.check(len(trap_findings) == 2 and not reviewed_findings, "keyword-sensitive instructions found only in the trap prompt")


if __name__ == "__main__":
    main()
