"""D3.1 - Simulate which memory files Claude Code loads, in what order, and why.

Claude Code builds its "memory" (always-on instructions) from several scopes:

    user     ~/.claude/CLAUDE.md, ~/.claude/rules/*.md    only you, every project, NOT in git
    project  CLAUDE.md or .claude/CLAUDE.md in the launch  the whole team, via git
             directory and every ancestor directory
    local    CLAUDE.local.md                              only you, this checkout, gitignored
    rule     .claude/rules/**/*.md without `paths:`        the team, loaded at launch like CLAUDE.md
    subdir   CLAUDE.md files BELOW the launch directory    loaded ON DEMAND, when Claude reads a file there

and inlines `@path` imports (path relative to the importing file, at most 4 hops deep, never
inside code spans or fenced code blocks). This module re-implements those rules over a plain
directory tree so you can see the result offline, the way `/memory` lists it in Claude Code.
The simulated filesystem boundary is the repo root (real Claude Code keeps walking up to /).

Run:  python memory_resolver.py
"""

from __future__ import annotations

import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

LAB = Path(__file__).resolve().parents[1]
EXAMPLE_REPO = LAB / "example-repo"
LEAD_HOME = LAB / "user-home-example"
TEAMMATE_HOME = LAB / "user-home-teammate"
RUNTIME = LAB / ".lab-runtime"

# Documented limit: imported files can import further files, up to four hops from the
# top-level memory file. Deeper imports are not expanded.
MAX_IMPORT_DEPTH = 4

# `@path` only when the @ starts a token: "platform@acme.example" (an email) is not an import.
IMPORT_RE = re.compile(r"(?<![\w@`])@((?:~/|\.\.?/|/)?[\w.\-]+(?:/[\w.\-]+)*)")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
INLINE_CODE_RE = re.compile(r"(`+).+?\1")


def tokens(text: str) -> int:
    """Rough token estimate (chars / 4) - good enough to compare configurations."""
    return max(1, len(text) // 4) if text else 0


def split_frontmatter(text: str) -> tuple[dict, str]:
    """Return (YAML frontmatter as a dict, body). Files without frontmatter return ({}, text)."""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            meta = yaml.safe_load(text[3:end]) or {}
            return (meta if isinstance(meta, dict) else {}), text[end + 4 :].lstrip("\n")
    return {}, text


def strip_code(text: str) -> str:
    """Blank out fenced code blocks and inline code spans, because imports are not parsed there.

    This is what lets a CLAUDE.md *mention* `@../../docs/standards/pci-dss.md` (in backticks) or show
    `npm i @types/node` in a fenced example without importing anything.
    """
    out: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        match = FENCE_RE.match(line)
        if match and (fence is None or line.strip().startswith(fence)):
            fence = match.group(1)[0] * 3 if fence is None else None
            out.append("")
            continue
        out.append("" if fence else INLINE_CODE_RE.sub("", line))
    return "\n".join(out)


def find_imports(text: str) -> list[str]:
    """The `@path` imports in a memory file, in document order, ignoring code."""
    _, body = split_frontmatter(text)
    return [m.group(1).rstrip(".,;:") for m in IMPORT_RE.finditer(strip_code(body))]


@dataclass
class MemoryFile:
    path: Path
    scope: str  # user | project | local | rule | subdir  (imports inherit their parent's scope)
    loaded: str  # launch | import | on demand
    reason: str
    text: str
    depth: int = 0  # import hops from the top-level memory file


@dataclass
class Resolution:
    user_home: Path
    repo_root: Path
    cwd: Path
    files: list[MemoryFile] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (what, why it did not load)

    def display(self, path: Path) -> str:
        """Paths the way a developer reads them: ~/... for the home dir, ./... for the repo."""
        for base, prefix in ((self.repo_root, "./"), (self.user_home, "~/")):
            if path == base or path.is_relative_to(base):
                return prefix + path.relative_to(base).as_posix()
        return path.as_posix()

    def find(self, needle: str) -> list[MemoryFile]:
        """Memory files whose text contains `needle` (case-insensitive)."""
        return [f for f in self.files if needle.lower() in f.text.lower()]

    def loaded(self, rel: str) -> MemoryFile | None:
        """The loaded entry for a display path such as './CLAUDE.md' or '~/.claude/CLAUDE.md'."""
        return next((f for f in self.files if self.display(f.path) == rel), None)

    def all_text(self) -> str:
        return "\n".join(f.text for f in self.files)

    def total_tokens(self) -> int:
        return sum(tokens(f.text) for f in self.files)

    def listing(self) -> str:
        """A /memory-style listing: load order, scope, how each file got there, token estimate."""
        rows = []
        for i, f in enumerate(self.files, 1):
            name = "    " * f.depth + ("@-> " if f.depth else "") + self.display(f.path)
            how = f"import ({f.depth} hop{'s' if f.depth > 1 else ''})" if f.depth else f.loaded
            estimate = f"~{tokens(f.text)}"
            rows.append(f"  {i:>2}  {f.scope:<8}{name:<46} {how:<16}{estimate:>5} tok  {f.reason}")
        rows.append(f"      total at this point: ~{self.total_tokens()} tokens")
        for what, why in self.skipped:
            rows.append(f"      not loaded: {what}  ({why})")
        return "\n".join(rows)


def _rule_files(rules_dir: Path) -> list[Path]:
    return sorted(p for p in rules_dir.rglob("*.md") if p.is_file()) if rules_dir.is_dir() else []


def _ancestors_from_root(cwd: Path, boundary: Path) -> list[Path]:
    """Directories from the boundary down to cwd (outermost first): broad context loads first."""
    chain = [cwd]
    while chain[-1] != boundary and chain[-1].parent != chain[-1] and chain[-1].is_relative_to(boundary):
        chain.append(chain[-1].parent)
    return list(reversed(chain))


def _dirs_below(cwd: Path, directory: Path) -> list[Path]:
    """Directories strictly below cwd down to `directory` (outermost first); [] if outside cwd."""
    if directory == cwd or not directory.is_relative_to(cwd):
        return []
    parts = directory.relative_to(cwd).parts
    return [cwd.joinpath(*parts[: i + 1]) for i in range(len(parts))]


class _Loader:
    def __init__(self, res: Resolution) -> None:
        self.res = res
        self.seen: set[Path] = set()

    def load(self, path: Path, scope: str, loaded: str, reason: str) -> None:
        if not path.is_file() or path in self.seen:
            return
        entry = MemoryFile(path, scope, loaded, reason, path.read_text(encoding="utf-8"))
        self.seen.add(path)
        self.res.files.append(entry)
        self._expand(entry, [path])

    def load_rules(self, rules_dir: Path, scope: str) -> None:
        for rule in _rule_files(rules_dir):
            meta, _ = split_frontmatter(rule.read_text(encoding="utf-8"))
            if meta.get("paths"):
                # Path-scoped rules wait until Claude touches a matching file - that is D3.3's topic.
                self.res.skipped.append((self.res.display(rule), "path-scoped rule; loads when a matching file is touched"))
                continue
            self.load(rule, scope, "launch", "rule without paths: always loaded")

    def _expand(self, parent: MemoryFile, chain: list[Path]) -> None:
        """Inline @imports depth-first, so each import sits right after the file that pulled it in."""
        for raw in find_imports(parent.text):
            target = _resolve_import(raw, parent.path.parent, self.res.user_home)
            what = f"@{raw} in {self.res.display(parent.path)}"
            if target in chain:
                cycle = " -> ".join(self.res.display(p) for p in [*chain, target])
                self.res.skipped.append((what, f"import cycle {cycle}"))
            elif not target.is_file():
                self.res.skipped.append((what, "no such file; left as plain text"))
            elif target in self.seen:
                self.res.skipped.append((what, "already loaded earlier; listed once"))
            elif parent.depth + 1 > MAX_IMPORT_DEPTH:
                self.res.skipped.append((what, f"deeper than the {MAX_IMPORT_DEPTH}-hop import limit"))
            else:
                child = MemoryFile(
                    target,
                    parent.scope,
                    "import",
                    f"imported by {self.res.display(parent.path)}",
                    target.read_text(encoding="utf-8"),
                    parent.depth + 1,
                )
                self.seen.add(target)
                self.res.files.append(child)
                self._expand(child, [*chain, target])


def _resolve_import(raw: str, base_dir: Path, user_home: Path) -> Path:
    """Imports resolve relative to the IMPORTING file (not the cwd); ~/ means the user's home."""
    if raw.startswith("~/"):
        return (user_home / raw[2:]).resolve()
    candidate = Path(raw)
    return candidate.resolve() if candidate.is_absolute() else (base_dir / candidate).resolve()


def resolve_memory(
    user_home: Path,
    repo_root: Path,
    cwd: Path | None = None,
    files_read: Iterable[str | Path] = (),
) -> Resolution:
    """Compute the memory files one developer's session has loaded.

    user_home  - that developer's home directory (holds .claude/CLAUDE.md, .claude/rules/)
    repo_root  - the checkout (also the simulated filesystem boundary for the ancestor walk)
    cwd        - where `claude` was launched (defaults to the repo root)
    files_read - files Claude has read, written or edited so far (paths relative to repo_root)

    Files are listed broadest first. All of them are concatenated into context; nothing overrides
    anything. If two instructions contradict each other Claude may follow either, so fix conflicts
    in the files instead of relying on load order.
    """
    user_home, repo_root = user_home.resolve(), repo_root.resolve()
    cwd = (cwd or repo_root).resolve()
    res = Resolution(user_home, repo_root, cwd)
    loader = _Loader(res)

    # 1. User scope: applies to every project, but lives only on this developer's machine.
    loader.load(user_home / ".claude" / "CLAUDE.md", "user", "launch", "user memory: only you, every project")
    loader.load_rules(user_home / ".claude" / "rules", "user")

    # 2. Launch directory and its ancestors, broadest first. CLAUDE.md / .claude/CLAUDE.md are
    #    committed (team); CLAUDE.local.md is gitignored (you, this checkout).
    for directory in _ancestors_from_root(cwd, repo_root):
        where = "launch dir" if directory == cwd else "ancestor of launch dir"
        loader.load(directory / "CLAUDE.md", "project", "launch", f"project memory ({where})")
        loader.load(directory / ".claude" / "CLAUDE.md", "project", "launch", f"project memory ({where})")
        loader.load(directory / "CLAUDE.local.md", "local", "launch", "local memory: you, this checkout")
        if directory == repo_root:
            # 3. Topic rules without `paths:` load at launch with the same priority as CLAUDE.md.
            loader.load_rules(repo_root / ".claude" / "rules", "rule")

    # 4. CLAUDE.md / CLAUDE.local.md files below the launch dir load lazily, once Claude reads,
    #    writes or edits a file in that subdirectory.
    for read in files_read:
        target = (repo_root / read).resolve()
        for directory in _dirs_below(cwd, target.parent):
            why = f"on demand: Claude touched {res.display(target)}"
            loader.load(directory / "CLAUDE.md", "subdir", "on demand", why)
            loader.load(directory / ".claude" / "CLAUDE.md", "subdir", "on demand", why)
            loader.load(directory / "CLAUDE.local.md", "local", "on demand", why)
    return res


def write_tree(root: Path, files: dict[str, str]) -> Path:
    """Create a small directory tree from {relative path: content} (fresh each run)."""
    shutil.rmtree(root, ignore_errors=True)
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
    return root


EDGE_CASE_TREE = {
    "home/.keep": "",
    "repo/CLAUDE.md": (
        "# Import edge cases\n\n"
        "Deep chain: @hops/hop1.md\n"
        "Cycle: @cycle/a.md\n"
        "Typo: @docs/does-not-exist.md\n"
        "Email, not an import: page oncall@acme.example\n"
        "Inline code is not parsed: `@hops/never.md`\n\n"
        "```bash\n"
        "pnpm add -D @types/node   # inside a fenced block: not an import\n"
        "```\n"
    ),
    "repo/hops/hop1.md": "hop 1 -> @hop2.md\n",
    "repo/hops/hop2.md": "hop 2 -> @hop3.md\n",
    "repo/hops/hop3.md": "hop 3 -> @hop4.md\n",
    "repo/hops/hop4.md": "hop 4 -> @hop5.md\n",
    "repo/hops/hop5.md": "hop 5: one hop too deep\n",
    "repo/hops/never.md": "should never load\n",
    "repo/cycle/a.md": "a imports @b.md\n",
    "repo/cycle/b.md": "b imports @a.md\n",
}


def main() -> None:
    lab.banner("D3.1  CLAUDE.md hierarchy: which memory files load, and when")

    lab.section("1. Lead developer launches `claude` at the repo root")
    res = resolve_memory(LEAD_HOME, EXAMPLE_REPO)
    print(res.listing())
    lab.check(res.files[0].scope == "user", "user memory (~/.claude/CLAUDE.md) loads first: broadest scope")
    root = res.loaded("./CLAUDE.md")
    git = res.loaded("./docs/standards/git-workflow.md")
    lab.check(root is not None and root.loaded == "launch", "project CLAUDE.md loads at launch")
    lab.check(git is not None and git.depth == 1, "@docs/standards/git-workflow.md is inlined one hop deep")
    rules = [f for f in res.files if f.scope == "rule"]
    lab.check(len(rules) == 3, ".claude/rules/*.md without paths (testing, api-conventions, deployment) load at launch")
    lab.check(not [f for f in res.files if f.scope == "subdir"], "no package CLAUDE.md yet: they load on demand")
    lab.check(
        res.loaded("./docs/standards/pci-dss.md") is None,
        "the backticked `@../../docs/standards/pci-dss.md` in the root CLAUDE.md is a mention, not an import",
    )

    lab.section("2. Same session, after Claude reads packages/payments/src/money.ts")
    res = resolve_memory(LEAD_HOME, EXAMPLE_REPO, files_read=["packages/payments/src/money.ts"])
    print(res.listing())
    payments = res.loaded("./packages/payments/CLAUDE.md")
    pci = res.loaded("./docs/standards/pci-dss.md")
    logging_ = res.loaded("./docs/standards/logging.md")
    lab.check(payments is not None and payments.loaded == "on demand", "packages/payments/CLAUDE.md loaded on demand")
    lab.check(pci is not None and pci.depth == 1, "@../../docs/standards/pci-dss.md resolved relative to the importing file")
    lab.check(logging_ is not None and logging_.depth == 2, "pci-dss.md's own @logging.md import resolved next to pci-dss.md (2 hops)")
    lab.check(res.loaded("./packages/web/CLAUDE.md") is None, "web conventions stay out of context: nothing in packages/web was read")

    lab.section("3. Launched from packages/web (cwd is a subdirectory)")
    res = resolve_memory(LEAD_HOME, EXAMPLE_REPO, cwd=EXAMPLE_REPO / "packages" / "web")
    print(res.listing())
    web = res.loaded("./packages/web/CLAUDE.md")
    lab.check(web is not None and web.loaded == "launch", "the launch directory's CLAUDE.md loads at launch")
    lab.check(res.loaded("./CLAUDE.md") is not None, "ancestor CLAUDE.md (repo root) still loads: the walk goes up")
    lab.check(res.loaded("./docs/standards/react.md") is not None, "web's @../../docs/standards/react.md import is inlined")

    lab.section("4. Import edge cases (generated under .lab-runtime/)")
    tree = write_tree(RUNTIME / "import-edge-cases", EDGE_CASE_TREE)
    res = resolve_memory(tree / "home", tree / "repo")
    print(res.listing())
    reasons = " | ".join(why for _, why in res.skipped)
    hop4 = res.loaded("./hops/hop4.md")
    lab.check(hop4 is not None and hop4.depth == 4, "a 4-hop import chain is followed to the end of the limit")
    lab.check(res.loaded("./hops/hop5.md") is None and "4-hop import limit" in reasons, "the 5th hop is not expanded")
    lab.check("import cycle" in reasons and res.loaded("./cycle/b.md") is not None, "a <-> b cycle detected; each file loads once")
    lab.check("no such file" in reasons, "a typo'd import is reported, not silently loaded")
    found = find_imports(EDGE_CASE_TREE["repo/CLAUDE.md"])
    lab.check(
        not any(i.startswith(("types", "hops/never", "acme")) for i in found),
        "emails, inline code and fenced code blocks are never treated as imports",
    )
    print("\nIn Claude Code, run /memory to see the real list for your session.")


if __name__ == "__main__":
    main()
