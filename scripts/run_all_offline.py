"""Run every Python lab entry point offline and report PASS/FAIL.

An entry point is any ``D*/python/*.py`` file that calls ``lab.banner(``. Files that
must not be auto-run (stdio MCP servers, live-only scripts) carry the marker
``LAB_SKIP_AUTORUN`` in a comment.

Usage:  python scripts/run_all_offline.py [filter]
        e.g. python scripts/run_all_offline.py D2.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TIMEOUT_S = 120


def entry_points(filter_: str) -> list[Path]:
    found = []
    for path in sorted(ROOT.glob("D*/python/*.py")):
        if filter_ and filter_ not in str(path.relative_to(ROOT)):
            continue
        source = path.read_text(encoding="utf-8")
        if "lab.banner(" in source and "LAB_SKIP_AUTORUN" not in source:
            found.append(path)
    return found


def main() -> int:
    filter_ = sys.argv[1] if len(sys.argv) > 1 else ""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    env.pop("LAB_LIVE", None)
    failures = []
    for path in entry_points(filter_):
        rel = path.relative_to(ROOT)
        start = time.perf_counter()
        try:
            proc = subprocess.run(
                [sys.executable, str(path)],
                cwd=path.parent,
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=TIMEOUT_S,
            )
            ok = proc.returncode == 0
            output = proc.stdout + proc.stderr
        except subprocess.TimeoutExpired:
            ok, output = False, f"timed out after {TIMEOUT_S}s"
        print(f"[{'PASS' if ok else 'FAIL'}] {rel}  ({time.perf_counter() - start:.1f}s)")
        if not ok:
            failures.append(rel)
            print("\n".join("    " + line for line in output.strip().splitlines()[-25:]))
    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
