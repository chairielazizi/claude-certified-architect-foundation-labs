"""Tiny re-implementations of Claude Code's file tools, with the same contracts (D2.5).

    grep(pattern, glob=None)  CONTENT search: regex over file contents -> (path, line_no, line)
    glob(pattern)             PATH matching: "**/*.test.tsx" -> matching file paths, no contents
    read(path)                full file contents (counted, so demos can show how much was read)
    write(path, content)      create or fully replace a file
    edit(path, old, new)      targeted replace; ``old`` must match EXACTLY ONCE, otherwise it
                              fails (0 matches: anchor wrong; >1: anchor ambiguous)

The real tools have more options; these keep the behaviour that drives tool choice.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path


class EditError(Exception):
    pass


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """'**/' = any number of directories (including none), '*' = within one path segment."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(f"^{out}$")


class Workspace:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.files_read: list[str] = []
        self.calls: list[str] = []  # tool-call log: "Grep ...", "Read ...", ...

    @classmethod
    def copy_of(cls, source: Path, runtime_dir: Path) -> "Workspace":
        """A fresh scratch copy (for demos that modify files) so reruns are deterministic."""
        if runtime_dir.exists():
            shutil.rmtree(runtime_dir)
        shutil.copytree(source, runtime_dir, ignore=shutil.ignore_patterns("__pycache__"))
        return cls(runtime_dir)

    def all_files(self) -> list[str]:
        return sorted(
            p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file() and "__pycache__" not in p.parts
        )

    def glob(self, pattern: str) -> list[str]:
        self.calls.append(f"Glob {pattern}")
        regex = glob_to_regex(pattern)
        return [f for f in self.all_files() if regex.match(f)]

    def grep(self, pattern: str, glob: str | None = None) -> list[tuple[str, int, str]]:
        self.calls.append(f"Grep {pattern}" + (f" (glob {glob})" if glob else ""))
        regex = re.compile(pattern)
        scope = glob_to_regex(glob) if glob else None
        hits = []
        for rel in self.all_files():
            if scope and not scope.match(rel):
                continue
            for n, line in enumerate((self.root / rel).read_text(encoding="utf-8").splitlines(), 1):
                if regex.search(line):
                    hits.append((rel, n, line.strip()))
        return hits

    def read(self, path: str) -> str:
        self.calls.append(f"Read {path}")
        self.files_read.append(path)
        return (self.root / path).read_text(encoding="utf-8")

    def write(self, path: str, content: str) -> None:
        self.calls.append(f"Write {path}")
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")

    def edit(self, path: str, old: str, new: str) -> None:
        self.calls.append(f"Edit {path}")
        text = (self.root / path).read_text(encoding="utf-8")
        count = text.count(old)
        if count == 0:
            raise EditError(f"old_string not found in {path}")
        if count > 1:
            raise EditError(f"old_string matches {count} places in {path}; provide more context to make it unique")
        (self.root / path).write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")
