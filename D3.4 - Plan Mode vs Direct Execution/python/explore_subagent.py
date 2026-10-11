"""D3.4 - Why verbose discovery belongs in the Explore subagent.

A library migration touching 45+ files starts with discovery: grep every import, read every caller.
Done in the main conversation, every search result and file body stays in context for the rest of the
task, which crowds out the implementation phase. Delegated to the Explore subagent (or a custom
read-only AgentDefinition), the raw output fills the SUBAGENT's context window and only a summary
comes back to the main conversation.

Always offline: it measures what each approach would put into the main context on a generated
48-caller codebase (chars / 4 as the token estimate).

Run:  python explore_subagent.py
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

LAB = Path(__file__).resolve().parents[1]
DEMO_REPO = LAB / ".lab-runtime" / "explore-demo"
CALLERS = 48
UNRELATED = 12
HELPERS = ["parse_date", "format_date", "days_between"]
CONTEXT_WINDOW = 200_000  # tokens; the exact size doesn't matter, the ratio does


def tokens(text: str) -> int:
    return max(1, len(text) // 4)


def generate_repo() -> None:
    """A deterministic codebase: 48 modules that use the legacy helpers, 12 that don't."""
    shutil.rmtree(DEMO_REPO, ignore_errors=True)
    for i in range(CALLERS + UNRELATED):
        area = ["billing", "shipping", "reports", "accounts", "catalog"][i % 5]
        path = DEMO_REPO / area / f"module_{i:02d}.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        used = [HELPERS[i % 3], HELPERS[(i + 1) % 3]] if i < CALLERS else []
        header = f"from common.legacy_dates import {', '.join(sorted(used))}\n\n" if used else ""
        body = "".join(
            f'\ndef handler_{n}(record):\n    """Process {area} record type {n} (validation, defaults, audit)."""\n'
            f"    value = record.get('field_{n}')\n"
            + (f"    stamp = {used[n % len(used)]}(value)\n" if used else "    stamp = value\n")
            + "    if stamp is None:\n        raise ValueError('missing value')\n    return {'id': record['id'], 'stamp': stamp}\n"
            for n in range(8)
        )
        path.write_text(f'"""{area} module {i:02d}."""\n\n{header}{body}', encoding="utf-8", newline="\n")


def grep(pattern: str) -> list[tuple[str, int, str]]:
    """What a Grep tool call returns: path, line number and line, for every match."""
    hits = []
    for path in sorted(DEMO_REPO.rglob("*.py")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(pattern, line):
                hits.append((path.relative_to(DEMO_REPO).as_posix(), number, line.strip()))
    return hits


def discovery_transcript() -> tuple[str, list[str]]:
    """Everything discovery produces: two greps plus a Read of each caller file."""
    import_hits = grep(r"from common\.legacy_dates import")
    call_hits = grep(r"\b(" + "|".join(HELPERS) + r")\(")
    files = sorted({hit[0] for hit in import_hits})
    parts = ["\n".join(f"{p}:{n}: {line}" for p, n, line in import_hits), "\n".join(f"{p}:{n}: {line}" for p, n, line in call_hits)]
    parts += [(DEMO_REPO / f).read_text(encoding="utf-8") for f in files]  # Read of every caller
    return "\n".join(parts), files


def explorer_summary(files: list[str]) -> str:
    """What the Explore subagent hands back: one line per caller, nothing else."""
    lines = [f"{len(files)} callers of common.legacy_dates (helpers used per file):"]
    for f in files:
        imported = re.search(r"import (.+)", (DEMO_REPO / f).read_text(encoding="utf-8")).group(1)  # type: ignore[union-attr]
        lines.append(f"- {f}: {imported}")
    lines.append("No dynamic imports or re-exports found; every call passes a single ISO string or date.")
    return "\n".join(lines)


def main() -> None:
    lab.banner("D3.4  Explore subagent: keep verbose discovery out of the main context")
    generate_repo()
    raw, files = discovery_transcript()
    summary = explorer_summary(files)

    lab.section("Discovery for a 48-file library migration")
    direct, delegated = tokens(raw), tokens(summary)
    print(f"  callers found: {len(files)}")
    print(f"  A. discovery in the main conversation : ~{direct:>6} tokens stay in main context ({direct / CONTEXT_WINDOW:.1%} of {CONTEXT_WINDOW:,})")
    print(f"  B. discovery in the Explore subagent  : ~{delegated:>6} tokens come back as a summary ({delegated / CONTEXT_WINDOW:.1%})")
    print(f"     (the subagent itself used ~{direct} tokens in ITS OWN context, which is discarded afterwards)")
    print("\n  summary returned to the main conversation (first lines):")
    print("\n".join("    " + line for line in summary.splitlines()[:6]) + "\n    ...")

    lab.section("Checks")
    lab.check(len(files) == CALLERS, f"discovery found all {CALLERS} callers and none of the {UNRELATED} unrelated modules")
    lab.check(delegated < direct * 0.1, "the summary is under 10% of the raw discovery output")
    lab.check(all(f in summary for f in files), "...and still names every caller, so the plan loses nothing")


if __name__ == "__main__":
    main()
