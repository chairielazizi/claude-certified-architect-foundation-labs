"""D3.2 - Inspect custom slash commands and skills the way Claude Code discovers them.

    .claude/commands/<name>.md          project command  -> /name   shared via git (the team)
    ~/.claude/commands/<name>.md        personal command -> /name   only you
    .claude/skills/<name>/SKILL.md      project skill    -> /name   shared via git (the team)
    ~/.claude/skills/<name>/SKILL.md    personal skill   -> /name   only you

The inspector parses frontmatter, validates the known fields, resolves name collisions (a skill beats
a command with the same name; a personal skill beats a project skill with the same name), shows which
skills run forked (context: fork -> isolated subagent) and which tools each one pre-approves, and
renders argument placeholders ($ARGUMENTS, $ARGUMENTS[N], 0-based $0 $1, named `arguments:`).

Run:  python skill_inspector.py
"""

from __future__ import annotations

import json
import re
import shlex
import shutil
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

LAB = Path(__file__).resolve().parents[1]
EXAMPLE_REPO = LAB / "example-repo"
USER_HOME = LAB / "user-home-example"
FIXTURES = LAB / "fixtures"
RUNTIME = LAB / ".lab-runtime"

SKILL_FIELDS = {
    "name", "description", "argument-hint", "arguments", "allowed-tools", "model",
    "disable-model-invocation", "user-invocable", "context", "agent", "paths",
}
COMMAND_FIELDS = SKILL_FIELDS - {"name", "paths"}  # commands accept the same fields except these
BUILT_IN_AGENTS = {"Explore", "Plan", "general-purpose"}
READ_ONLY_AGENTS = {"Explore", "Plan"}  # their tool set has no Write/Edit
FILE_WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
KNOWN_TOOLS = {
    "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch",
    "NotebookEdit", "Agent", "Task", "TodoWrite", "Skill",
}
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")  # lowercase letters, digits, hyphens; max 64 chars
TOOL_RE = re.compile(r"^([A-Za-z_]\w*)(?:\((.*)\))?$")  # Tool or Tool(specifier), e.g. Bash(git diff *)
SHELL_RE = re.compile(r"(?:(?<=\s)|^)!`([^`]+)`", re.M)  # !`cmd` at line start or after whitespace
POSITIONAL_RE = re.compile(r"\$ARGUMENTS\[(\d+)\]|\$(\d+)")
ESCAPED_DOLLAR = "\x00DOLLAR\x00"  # \$ in a skill means a literal dollar sign


def split_frontmatter(text: str) -> tuple[dict, str]:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            meta = yaml.safe_load(text[3:end]) or {}
            return (meta if isinstance(meta, dict) else {}), text[end + 4 :].lstrip("\n")
    return {}, text


def split_list(value: object) -> list[str]:
    """`allowed-tools` / `arguments` accept a YAML list or a space/comma-separated string.

    Splitting must respect parentheses: `Bash(git diff *)` is ONE entry even though it has spaces.
    """
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    items, current, depth = [], "", 0
    for ch in str(value):
        depth += (ch == "(") - (ch == ")")
        if depth == 0 and (ch.isspace() or ch == ","):
            if current:
                items.append(current)
            current = ""
            continue
        current += ch
    return items + ([current] if current else [])


def hint_slots(hint: str) -> list[str]:
    """`"[ComponentName] [directory]"` -> ["ComponentName", "directory"]."""
    return re.findall(r"\[([^\]]+)\]", hint) or hint.split()


@dataclass
class Entry:
    name: str
    kind: str  # skill | command
    scope: str  # project | personal
    path: Path
    meta: dict
    body: str

    @property
    def slash(self) -> str:
        return f"/{self.name}"

    @property
    def allowed_tools(self) -> list[str]:
        return split_list(self.meta.get("allowed-tools"))

    @property
    def argument_names(self) -> list[str]:
        return split_list(self.meta.get("arguments"))

    @property
    def forked(self) -> bool:
        return self.meta.get("context") == "fork"

    @property
    def agent(self) -> str | None:
        """Which subagent runs a forked skill (general-purpose when `agent:` is omitted)."""
        return (self.meta.get("agent") or "general-purpose") if self.forked else None

    @property
    def invocation(self) -> str:
        by_user = self.meta.get("user-invocable", True) is not False
        by_model = self.meta.get("disable-model-invocation", False) is not True
        return {(True, True): "you or Claude", (True, False): "you only", (False, True): "Claude only"}.get(
            (by_user, by_model), "nobody"
        )

    @property
    def required_args(self) -> int:
        """How many arguments must be supplied before the prompt makes sense.

        Positional slots used in the body ($0, $1, $ARGUMENTS[N]) and named `arguments:` are required.
        A body that only uses $ARGUMENTS needs one value per argument-hint slot that is not marked
        "optional" (a convention of this lab: Claude Code itself only *shows* the hint).
        """
        body = self.body.replace("\\$", "")
        used = [int(a or b) for a, b in POSITIONAL_RE.findall(body)]
        needed = max([i + 1 for i in used] + [len(self.argument_names), 0])
        hint = str(self.meta.get("argument-hint") or "")
        if needed == 0 and "$ARGUMENTS" in body and hint:
            needed = len([s for s in hint_slots(hint) if not s.lower().startswith("optional")])
        return needed


def discover(project_root: Path, user_home: Path | None) -> list[Entry]:
    """Every command and skill visible to one developer (project + their personal ones)."""
    found: list[Entry] = []
    scopes = [("project", project_root / ".claude")] + ([("personal", user_home / ".claude")] if user_home else [])
    for scope, base in scopes:
        for path in sorted((base / "commands").glob("*.md")):
            meta, body = split_frontmatter(path.read_text(encoding="utf-8"))
            found.append(Entry(path.stem, "command", scope, path, meta, body))
        for path in sorted((base / "skills").glob("*/SKILL.md")):
            meta, body = split_frontmatter(path.read_text(encoding="utf-8"))
            found.append(Entry(str(meta.get("name") or path.parent.name), "skill", scope, path, meta, body))
    return found


# Higher rank wins a name collision. Skills: enterprise > personal > project; a skill beats a command.
# Two COMMANDS with the same name in personal and project scope: precedence is not documented.
RANK = {("skill", "personal"): 3, ("skill", "project"): 2, ("command", "personal"): 1, ("command", "project"): 1}


@dataclass
class Slot:
    name: str
    winner: Entry
    shadowed: list[Entry]
    note: str


def resolve_names(entries: list[Entry]) -> dict[str, Slot]:
    """What each /name actually runs for this developer, and what it hides."""
    groups: dict[str, list[Entry]] = defaultdict(list)
    for entry in entries:
        groups[entry.name].append(entry)
    slots: dict[str, Slot] = {}
    for name, group in sorted(groups.items()):
        ranked = sorted(group, key=lambda e: RANK[(e.kind, e.scope)], reverse=True)
        winner, rest = ranked[0], ranked[1:]
        notes = []
        for loser in rest:
            if RANK[(loser.kind, loser.scope)] == RANK[(winner.kind, winner.scope)]:
                notes.append("AMBIGUOUS: personal and project command share this name (undocumented precedence) - rename one")
            elif loser.kind == "command" and winner.kind == "skill":
                notes.append(f"{loser.scope} command shadowed: a skill beats a command with the same name")
            else:
                notes.append(f"{loser.scope} skill shadowed: a personal skill beats a project skill with the same name")
        slots[name] = Slot(name, winner, rest, "; ".join(notes))
    return slots


def validate(entry: Entry, project_root: Path) -> tuple[list[str], list[str]]:
    """(errors, warnings) for one command or skill file."""
    errors: list[str] = []
    warnings: list[str] = []
    allowed = SKILL_FIELDS if entry.kind == "skill" else COMMAND_FIELDS
    for key in entry.meta:
        if key == "tools":
            warnings.append("unknown field 'tools' (that is the subagent-file field; skills use allowed-tools)")
        elif key not in SKILL_FIELDS:
            warnings.append(f"unknown field {key!r} is ignored")
        elif key not in allowed:
            warnings.append(f"{key!r} only applies to skills, not commands")
    if not entry.meta.get("description"):
        warnings.append("no description: Claude cannot tell when the skill is relevant")
    if entry.kind == "skill" and (not NAME_RE.match(entry.name) or len(entry.name) > 64):
        errors.append(f"name {entry.name!r} must be lowercase letters, digits and hyphens (max 64)")
    context = entry.meta.get("context")
    if context is not None and context != "fork":
        errors.append(f"context: {context!r} is invalid; the only value is 'fork'")
    agent = entry.meta.get("agent")
    if agent and context != "fork":
        warnings.append("agent is ignored unless context: fork is set")
    if agent and agent not in BUILT_IN_AGENTS and not (project_root / ".claude" / "agents" / f"{agent}.md").is_file():
        errors.append(f"agent {agent!r} is not built-in (Explore, Plan, general-purpose) or in .claude/agents/")
    for tool in entry.allowed_tools:
        match = TOOL_RE.match(tool)
        if not match or (match.group(1) not in KNOWN_TOOLS and not match.group(1).startswith("mcp__")):
            warnings.append(f"allowed-tools entry {tool!r} is not a known tool")
    for flag in ("disable-model-invocation", "user-invocable"):
        if flag in entry.meta and not isinstance(entry.meta[flag], bool):
            errors.append(f"{flag} must be true or false")
    hint = str(entry.meta.get("argument-hint") or "")
    if entry.required_args and not hint:
        warnings.append(f"needs {entry.required_args} argument(s) but has no argument-hint to tell people what to pass")
    elif hint and entry.required_args > len(hint_slots(hint)):
        warnings.append(f"argument-hint names {len(hint_slots(hint))} slot(s) but the body uses {entry.required_args}")
    return errors, warnings


# ---------------------------------------------------------------------------
# Permissions: allowed-tools PRE-APPROVES tools; deny rules and the agent's tool set restrict them
# ---------------------------------------------------------------------------


def load_settings(project_root: Path) -> dict:
    path = project_root / ".claude" / "settings.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def rule_matches(rule: str, call: str) -> bool:
    """`Bash(git diff *)` matches the call `Bash(git diff main...HEAD)`; a bare `Write` matches any Write."""
    rule_m, call_m = TOOL_RE.match(rule), TOOL_RE.match(call)
    if not rule_m or not call_m or rule_m.group(1) != call_m.group(1):
        return False
    if rule_m.group(2) is None:
        return True
    pattern = "^" + ".*".join(re.escape(part) for part in rule_m.group(2).split("*")) + "$"
    return re.match(pattern, call_m.group(2) or "") is not None


def decide_permission(call: str, entry: Entry, settings: dict) -> str:
    """What happens when Claude tries `call` while this skill is active (deny rules are checked first)."""
    tool = (TOOL_RE.match(call) or re.match(r"(\w+)", call)).group(1)  # type: ignore[union-attr]
    if entry.forked and entry.agent in READ_ONLY_AGENTS and tool in FILE_WRITE_TOOLS:
        return f"unavailable (the {entry.agent} subagent has no write tools)"
    perms = settings.get("permissions", {})
    if any(rule_matches(rule, call) for rule in perms.get("deny", [])):
        return "deny (settings.json deny rule)"
    if any(rule_matches(rule, call) for rule in entry.allowed_tools):
        return "allow (pre-approved by allowed-tools)"
    if any(rule_matches(rule, call) for rule in perms.get("allow", [])):
        return "allow (settings.json allow rule)"
    return "ask (not pre-approved, so Claude must ask you)"


# ---------------------------------------------------------------------------
# Argument rendering
# ---------------------------------------------------------------------------


@dataclass
class Rendered:
    prompt: str | None  # what Claude receives; None when the developer must supply more input
    ask_user: str | None  # the argument-hint prompt shown instead
    args: list[str]
    shell_commands: list[str]  # !`cmd` lines Claude Code runs first; their output replaces the line


def offline_shell(command: str) -> str:
    """Offline stand-in for !`cmd` injection: canned output, nothing is executed."""
    if command.startswith("git diff --stat"):
        return (FIXTURES / "git-diff-stat.txt").read_text(encoding="utf-8").rstrip("\n")
    return f"[output of `{command}` goes here]"


def split_args(raw: str) -> list[str]:
    """Shell-style quoting: "two words" is one argument. Unbalanced quotes (can't) fall back to spaces."""
    try:
        return shlex.split(raw)
    except ValueError:
        return raw.split()


def render(entry: Entry, raw: str, shell: Callable[[str], str] = offline_shell) -> Rendered:
    """Expand placeholders the way Claude Code does when you type `/name raw`."""
    args = split_args(raw)
    if len(args) < entry.required_args:
        hint = str(entry.meta.get("argument-hint") or "")
        return Rendered(None, f"{entry.slash} needs {entry.required_args} argument(s). Usage: {entry.slash} {hint}".rstrip(), args, [])

    names = sorted(entry.argument_names, key=len, reverse=True)
    alternatives = [r"\$ARGUMENTS\[(?P<idx>\d+)\]", r"\$ARGUMENTS(?!\w)", r"\$(?P<pos>\d+)"]
    if names:
        alternatives.append(r"\$(?P<named>" + "|".join(map(re.escape, names)) + r")(?!\w)")
    pattern = re.compile("|".join(alternatives))
    received = False

    def substitute(match: re.Match[str]) -> str:
        # One pass over the ORIGINAL text, so a value containing "$1" is never substituted again.
        nonlocal received
        if match.group("idx") is not None or match.group("pos") is not None:
            index = int(match.group("idx") or match.group("pos"))  # 0-based: $0 is the FIRST argument
        elif names and match.group("named") is not None:
            index = entry.argument_names.index(match.group("named"))
        else:
            received = received or bool(args)
            return raw.strip()
        if index < len(args):
            received = True
            return args[index]
        return ""  # a placeholder with no argument at its position expands to an empty string

    text = pattern.sub(substitute, entry.body.replace("\\$", ESCAPED_DOLLAR))
    if args and not received:
        # Documented fallback: arguments no placeholder received are appended, so they are never lost.
        text = text.rstrip("\n") + f"\n\nARGUMENTS: {raw.strip()}\n"
    commands = SHELL_RE.findall(text)
    text = SHELL_RE.sub(lambda m: shell(m.group(1)), text).replace(ESCAPED_DOLLAR, "$")
    return Rendered(text, None, args, commands)


def write_tree(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")


def fresh_copy(name: str) -> tuple[Path, Path]:
    """A throwaway copy of the example repo + personal home under .lab-runtime/ (rebuilt every run)."""
    base = RUNTIME / name
    shutil.rmtree(base, ignore_errors=True)
    shutil.copytree(EXAMPLE_REPO, base / "repo")
    shutil.copytree(USER_HOME, base / "home")
    return base / "repo", base / "home"


def table(entries: list[Entry]) -> str:
    rows = [f"  {'/name':<26}{'kind':<9}{'scope':<10}{'runs':<27}{'pre-approved tools':<50}invoked by"]
    for e in entries:
        runs = f"forked -> {e.agent}" if e.forked else "inline (main context)"
        rows.append(f"  {e.slash:<26}{e.kind:<9}{e.scope:<10}{runs:<27}{' '.join(e.allowed_tools) or '-':<50}{e.invocation}")
    return "\n".join(rows)


BROKEN_SKILL = """---
name: Summarize_Module
context: forked
agent: Explorer
tools: Read Grep
---
Summarize the module $1 for a newcomer.
"""

LEGACY_COMMAND = """---
description: (legacy) codebase analysis, kept from before the skill existed
---
Analyze $ARGUMENTS and summarize it.
"""

NAIVE_PERSONAL_REVIEW = """---
name: review
description: My tweaked copy of the team review
---
Review the current branch. Be extra strict about naming.
"""


def main() -> None:
    lab.banner("D3.2  Skill and command inspector: scopes, frontmatter, collisions, forking")

    lab.section("1. What the lead developer sees (project + personal)")
    entries = discover(EXAMPLE_REPO, USER_HOME)
    print(table(entries))
    by_name = {e.name: e for e in entries}
    lab.check(by_name["review"].kind == "command" and by_name["review"].scope == "project", "/review is a project command (.claude/commands/), shared via git")
    lab.check(by_name["my-standup"].scope == "personal" and by_name["review-strict"].scope == "personal", "my-standup and review-strict are personal (~/.claude/): only this developer has them")
    teammate = {e.name for e in discover(EXAMPLE_REPO, None)}
    lab.check({"review", "codebase-analysis", "scaffold-component", "brainstorm-alternatives"} <= teammate and "my-standup" not in teammate, "a teammate with an empty home gets every project entry and no personal ones")

    lab.section("2. Frontmatter validation of the committed samples")
    clean = True
    for e in entries:
        errors, warnings = validate(e, EXAMPLE_REPO)
        clean = clean and not errors and not warnings
        print(f"  {e.slash:<26}{'OK' if not errors and not warnings else errors + warnings}")
    lab.check(clean, "all committed commands and skills validate cleanly")

    lab.section("3. Validation catches a broken skill (generated under .lab-runtime/)")
    repo, home = fresh_copy("broken")
    write_tree(repo, {".claude/skills/summarize-module/SKILL.md": BROKEN_SKILL})
    broken = next(e for e in discover(repo, home) if e.path.parent.name == "summarize-module")
    errors, warnings = validate(broken, repo)
    for line in errors:
        print(f"  ERROR    {line}")
    for line in warnings:
        print(f"  WARNING  {line}")
    lab.check(len(errors) == 3, "bad name, context: forked (must be 'fork') and unknown agent 'Explorer' are errors")
    lab.check(any("'tools'" in w for w in warnings) and any("argument-hint" in w for w in warnings), "'tools' instead of allowed-tools, and $1 with no argument-hint, are flagged")

    lab.section("4. Name collisions")
    repo, home = fresh_copy("collisions")
    write_tree(repo, {".claude/commands/codebase-analysis.md": LEGACY_COMMAND})
    write_tree(home, {".claude/skills/review/SKILL.md": NAIVE_PERSONAL_REVIEW})
    lead = resolve_names(discover(repo, home))
    mate = resolve_names(discover(repo, None))
    for name in ("codebase-analysis", "review"):
        slot = lead[name]
        print(f"  lead     /{name:<20} -> {slot.winner.kind} ({slot.winner.scope})   {slot.note}")
        print(f"  teammate /{name:<20} -> {mate[name].winner.kind} ({mate[name].winner.scope})")
    lab.check(lead["codebase-analysis"].winner.kind == "skill", "a skill beats a leftover command with the same name")
    lab.check(lead["review"].winner.scope == "personal", "a personal skill named 'review' silently shadows the team /review - for the lead")
    lab.check(mate["review"].winner.scope == "project", "teammates are unaffected, but the lead no longer gets team checklist updates")
    committed = resolve_names(entries)
    lab.check(
        committed["review"].winner.scope == "project" and "review-strict" in committed,
        "the right way: a personal variant with a DIFFERENT name (/review-strict) keeps both available",
    )

    lab.section("5. Forked execution and tool access")
    settings = load_settings(EXAMPLE_REPO)
    calls = ["Read(src/components/Button.tsx)", "Write(src/components/Button.tsx)", "Bash(pnpm add left-pad)", "Bash(rm -rf src)"]
    for name in ("codebase-analysis", "scaffold-component"):
        e = by_name[name]
        print(f"  /{name}  ({'forked -> ' + str(e.agent) if e.forked else 'inline'}, allowed-tools: {' '.join(e.allowed_tools)})")
        for call in calls:
            print(f"      {call:<36} {decide_permission(call, e, settings)}")
    forked = sorted(e.name for e in entries if e.forked)
    lab.check(forked == ["brainstorm-alternatives", "codebase-analysis"], "verbose analysis and exploratory brainstorming run forked (context: fork)")
    lab.check(by_name["codebase-analysis"].agent == "Explore" and by_name["brainstorm-alternatives"].agent == "general-purpose", "agent: Explore for codebase-analysis; brainstorm uses the default general-purpose agent")
    scaffold = by_name["scaffold-component"]
    lab.check(decide_permission("Write(src/components/Button.tsx)", scaffold, settings).startswith("allow"), "scaffold-component's Write is pre-approved by allowed-tools: Read Write")
    lab.check(decide_permission("Bash(rm -rf src)", scaffold, settings).startswith("deny"), "a destructive command is blocked by the settings.json deny rule")
    lab.check(decide_permission("Bash(pnpm add left-pad)", scaffold, settings).startswith("ask"), "allowed-tools does not hide Bash: an unlisted tool still prompts")
    lab.check(decide_permission("Write(x.ts)", by_name["codebase-analysis"], settings).startswith("unavailable"), "the Explore agent behind a forked skill cannot write at all")


if __name__ == "__main__":
    main()
