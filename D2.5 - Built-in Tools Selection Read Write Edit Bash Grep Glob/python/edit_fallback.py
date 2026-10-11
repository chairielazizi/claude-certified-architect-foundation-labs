"""D2.5 - Edit needs a unique anchor; when it cannot get one, fall back to Read + Write.

Task: raise the REFUNDS timeout to 45 in config/settings.py, leaving PAYMENTS alone.
The line '"timeout_seconds": 30,' appears in BOTH blocks, so:

  1. Edit('"timeout_seconds": 30,' -> ...)     fails: 2 matches (ambiguous anchor)
  2. Edit with a slightly wrong anchor          fails: 0 matches
  3. fallback: Read the whole file, change the line inside the REFUNDS block in memory,
     Write the whole file back                  works, and only that one line changes
  (A longer anchor that includes the unique '"window_days"' line also makes Edit work;
   shown last on a fresh copy. Read + Write is the fallback that always works.)

Works on a scratch copy in .lab-runtime/ so sample_repo/ never changes.
Always offline. Run:  python edit_fallback.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from mini_tools import EditError, Workspace  # noqa: E402

LAB_DIR = Path(__file__).resolve().parents[1]
SAMPLE_REPO = LAB_DIR / "sample_repo"
RUNTIME = LAB_DIR / ".lab-runtime"
TARGET = "config/settings.py"


def timeouts(text: str) -> tuple[int, int]:
    """(payments timeout, refunds timeout) as written in the file."""
    pay = re.search(r'PAYMENTS = \{[^}]*"timeout_seconds": (\d+)', text)
    ref = re.search(r'REFUNDS = \{[^}]*"timeout_seconds": (\d+)', text)
    assert pay and ref
    return int(pay.group(1)), int(ref.group(1))


def set_refunds_timeout(text: str, value: int) -> str:
    """In-memory edit with full context: only the line inside the REFUNDS block changes."""
    lines = text.splitlines(keepends=True)
    in_refunds = False
    for i, line in enumerate(lines):
        if line.startswith("REFUNDS = {"):
            in_refunds = True
        elif in_refunds and line.strip().startswith('"timeout_seconds"'):
            lines[i] = re.sub(r"\d+", str(value), line, count=1)
            break
        elif in_refunds and line.startswith("}"):
            break
    return "".join(lines)


def main() -> None:
    lab.banner("D2.5  Edit's unique-match rule and the Read + Write fallback")
    ws = Workspace.copy_of(SAMPLE_REPO, RUNTIME / "workspace")
    original = (ws.root / TARGET).read_text(encoding="utf-8")
    print(f"  {TARGET} before: payments/refunds timeout = {timeouts(original)}")

    lab.section("1. Edit with an ambiguous anchor")
    errors = []
    try:
        ws.edit(TARGET, '"timeout_seconds": 30,', '"timeout_seconds": 45,')
    except EditError as exc:
        errors.append(str(exc))
        print(f"  EditError: {exc}")

    lab.section("2. Edit with an anchor that is not in the file")
    try:
        ws.edit(TARGET, '"timeout_seconds":30', '"timeout_seconds":45')
    except EditError as exc:
        errors.append(str(exc))
        print(f"  EditError: {exc}")

    lab.section("3. Fallback: Read the full file, modify in memory, Write it back")
    text = ws.read(TARGET)
    updated = set_refunds_timeout(text, 45)
    ws.write(TARGET, updated)
    after = (ws.root / TARGET).read_text(encoding="utf-8")
    changed = [(a, b) for a, b in zip(original.splitlines(), after.splitlines()) if a != b]
    print(f"  after: payments/refunds timeout = {timeouts(after)}")
    print(f"  changed lines: {changed}")
    print(f"  tool calls: {ws.calls}")

    lab.section("Alternative: a longer, unique anchor (fresh copy)")
    ws2 = Workspace.copy_of(SAMPLE_REPO, RUNTIME / "workspace-anchor")
    ws2.edit(TARGET, '"window_days": 30,\n    "timeout_seconds": 30,', '"window_days": 30,\n    "timeout_seconds": 45,')
    after2 = (ws2.root / TARGET).read_text(encoding="utf-8")
    print(f"  after: payments/refunds timeout = {timeouts(after2)}")

    lab.section("Checks")
    lab.check(len(errors) == 2 and "2 places" in errors[0] and "not found" in errors[1], "Edit refuses both an ambiguous (2 matches) and a missing (0 matches) anchor")
    lab.check(timeouts(after) == (30, 45), "Read + Write changed only the REFUNDS timeout")
    lab.check(len(changed) == 1, "exactly one line differs from the original")
    lab.check(timeouts(after2) == (30, 45), "a longer anchor with unique context also works for Edit")
    lab.check(timeouts((SAMPLE_REPO / TARGET).read_text(encoding="utf-8")) == (30, 30), "sample_repo/ itself is untouched (demo ran on a scratch copy)")


if __name__ == "__main__":
    main()
