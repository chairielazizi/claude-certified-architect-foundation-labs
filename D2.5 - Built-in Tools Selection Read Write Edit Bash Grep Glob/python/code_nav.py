"""Small helpers for following Python imports in sample_repo (D2.5).

These are what an agent does "in its head" after a Read: look at the import lines,
work out which file a name comes from, and decide what to open next.
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath

FROM_IMPORT = re.compile(r"^\s*from\s+([.\w]+)\s+import\s+(.+)$")


def imported_names(line: str) -> list[tuple[str, str]]:
    """'from m import a as b, c' -> [('a', 'b'), ('c', 'c')]  (original, local name)."""
    match = FROM_IMPORT.match(line)
    if not match:
        return []
    names = match.group(2).split("#")[0].replace("(", "").replace(")", "")
    pairs = []
    for part in names.split(","):
        bits = part.split()
        if len(bits) == 3 and bits[1] == "as":
            pairs.append((bits[0], bits[2]))
        elif len(bits) == 1:
            pairs.append((bits[0], bits[0]))
    return pairs


def parse_imports(source: str) -> dict[str, tuple[str, str]]:
    """local name -> (module, original name) for every from-import in a file."""
    found = {}
    for line in source.splitlines():
        match = FROM_IMPORT.match(line)
        if match:
            for original, local in imported_names(line):
                found[local] = (match.group(1), original)
    return found


def resolve_module(module: str, from_file: str, files: list[str]) -> str | None:
    """Module path (absolute or relative) -> the repo file that defines it."""
    if module.startswith("."):
        level = len(module) - len(module.lstrip("."))
        base = PurePosixPath(from_file).parent
        for _ in range(level - 1):
            base = base.parent
        rest = module.lstrip(".")
        parts = [*base.parts, *rest.split(".")] if rest else list(base.parts)
    else:
        parts = module.split(".")
    stem = "/".join(parts)
    for candidate in (f"{stem}.py", f"{stem}/__init__.py"):
        if candidate in files:
            return candidate
    return None
