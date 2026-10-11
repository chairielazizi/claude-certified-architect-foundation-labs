"""D3.3 - Which .claude/rules/ files load for the files being edited?

    .claude/rules/general.md              no paths:  -> loaded at launch, every session
    .claude/rules/tests.md                paths: ["**/*.test.tsx", "**/*.test.ts"]
                                          -> loaded only when Claude reads/edits a matching file

`paths:` is a YAML list of globs or a comma-separated string. This loader parses the frontmatter,
matches globs with glob_match.py, and reports, for a set of touched files, which rules load and why.

Run:  python rule_loader.py
"""

from __future__ import annotations

import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from glob_match import SELF_TEST, glob_match  # noqa: E402

LAB = Path(__file__).resolve().parents[1]
EXAMPLE_REPO = LAB / "example-repo"
RUNTIME = LAB / ".lab-runtime"


class RuleError(ValueError):
    pass


def tokens(text: str) -> int:
    """Rough token estimate (chars / 4)."""
    return max(1, len(text) // 4) if text else 0


@dataclass
class Rule:
    name: str  # path relative to .claude/rules/
    paths: list[str]  # [] = unconditional
    text: str  # everything that enters context when the rule loads

    @property
    def conditional(self) -> bool:
        return bool(self.paths)

    def matches(self, file: str) -> str | None:
        """The first glob that matches `file`, or None."""
        return next((p for p in self.paths if glob_match(p, file)), None)


def parse_paths(value: object, where: str) -> list[str]:
    """`paths:` may be a YAML list or one comma-separated string."""
    if value is None:
        return []
    if isinstance(value, str):
        return [p.strip() for p in value.split(",") if p.strip()]
    if isinstance(value, list) and all(isinstance(p, str) for p in value):
        return [p.strip() for p in value]
    raise RuleError(f"{where}: paths must be a list of glob strings or a comma-separated string")


def parse_rule(name: str, text: str) -> Rule:
    if not text.startswith("---"):
        return Rule(name, [], text)
    end = text.find("\n---", 3)
    if end == -1:
        raise RuleError(f"{name}: frontmatter opened with --- but never closed")
    try:
        meta = yaml.safe_load(text[3:end]) or {}
    except yaml.YAMLError as exc:
        # The classic mistake: an unquoted glob that starts with * is a YAML alias, not a string.
        raise RuleError(f"{name}: invalid YAML frontmatter ({exc.__class__.__name__}); quote globs that start with * or {{") from exc
    return Rule(name, parse_paths(meta.get("paths"), name), text)


def load_rules(project_root: Path) -> list[Rule]:
    rules_dir = project_root / ".claude" / "rules"
    return [
        parse_rule(p.relative_to(rules_dir).as_posix(), p.read_text(encoding="utf-8"))
        for p in sorted(rules_dir.rglob("*.md"))
    ]


@dataclass
class Activation:
    rule: Rule
    why: str  # "always" or "<glob> matched <file>"


def rules_for(rules: list[Rule], touched: Iterable[str]) -> list[Activation]:
    """Rules in context once Claude has touched these files (unconditional ones are always there)."""
    touched = list(touched)
    active = []
    for rule in rules:
        if not rule.conditional:
            active.append(Activation(rule, "always (no paths:)"))
            continue
        for file in touched:
            glob = rule.matches(file)
            if glob:
                active.append(Activation(rule, f"{glob!r} matched {file}"))
                break
    return active


def repo_files(project_root: Path) -> list[str]:
    """Project-relative source files (configuration under .claude/ excluded)."""
    return sorted(
        p.relative_to(project_root).as_posix()
        for p in project_root.rglob("*")
        if p.is_file() and ".claude" not in p.relative_to(project_root).parts and p.name != "CLAUDE.md"
    )


SESSIONS: dict[str, tuple[list[str], set[str]]] = {
    # name: (files Claude edits, rules expected in context)
    "edit a Terraform module": (["terraform/modules/network/main.tf"], {"general.md", "terraform.md"}),
    "edit a component": (["src/components/Button.tsx"], {"general.md", "react-components.md"}),
    "edit a component test": (["src/components/Button.test.tsx"], {"general.md", "tests.md", "react-components.md"}),
    "edit a nested form test": (["src/components/forms/TextField.test.tsx"], {"general.md", "tests.md", "react-components.md"}),
    "edit a library test": (["src/lib/money.test.ts"], {"general.md", "tests.md"}),
    "edit an API handler": (["src/api/orders.ts"], {"general.md", "api.md"}),
    "edit an e2e test": (["e2e/checkout.test.ts"], {"general.md", "tests.md"}),
}


def main() -> None:
    lab.banner("D3.3  Path-specific rules: which conventions load for which files")

    lab.section("1. Glob matcher self-test (**, *, ?, {a,b}, [!x])")
    failures = [(p, f, exp) for p, f, exp in SELF_TEST if glob_match(p, f) != exp]
    for pattern, file, expected in SELF_TEST:
        print(f"  {pattern:<26} {file:<42} {'match' if expected else 'no match'}")
    lab.check(not failures, f"all {len(SELF_TEST)} glob cases behave as expected")

    lab.section("2. Rules in example-repo/.claude/rules/")
    rules = load_rules(EXAMPLE_REPO)
    for rule in rules:
        estimate = f"~{tokens(rule.text)}"
        print(f"  {rule.name:<22}{estimate:>5} tok   {rule.paths if rule.conditional else 'always (no paths:)'}")
    lab.check([r.name for r in rules if not r.conditional] == ["general.md"], "only general.md is unconditional")
    lab.check(next(r for r in rules if r.name == "tests.md").paths == ["**/*.test.tsx", "**/*.test.ts"], "tests.md uses a YAML block list of two globs")

    lab.section("3. What loads, per editing session")
    files = repo_files(EXAMPLE_REPO)
    for title, (touched, expected) in SESSIONS.items():
        active = rules_for(rules, touched)
        names = {a.rule.name for a in active}
        print(f"\n  {title}: {', '.join(touched)}")
        for a in active:
            print(f"    + {a.rule.name:<22} {a.why}")
        lab.check(names == expected and all(f in files for f in touched), f"{title}: exactly {sorted(expected)}")
    tests_rule = next(r for r in rules if r.name == "tests.md")
    test_files = [f for f in files if tests_rule.matches(f)]
    print(f"\n  tests.md covers {len(test_files)} test files in {len({f.rsplit('/', 1)[0] if '/' in f else '.' for f in test_files})} directories: {test_files}")
    lab.check(len(test_files) == 5, "one rule file covers every test file, wherever it lives")

    lab.section("4. Frontmatter gotchas (generated under .lab-runtime/)")
    comma = parse_rule("styles.md", '---\npaths: "src/**/*.css, src/**/*.module.css"\n---\n# Styles\n')
    print(f"  comma-separated string -> {comma.paths}")
    lab.check(comma.paths == ["src/**/*.css", "src/**/*.module.css"], "a comma-separated paths string is split into globs")
    bad_dir = RUNTIME / "bad-rules"
    shutil.rmtree(bad_dir, ignore_errors=True)
    (bad_dir / ".claude" / "rules").mkdir(parents=True)
    (bad_dir / ".claude" / "rules" / "unquoted.md").write_text("---\npaths: **/*.test.ts\n---\n# Oops\n", encoding="utf-8", newline="\n")
    try:
        load_rules(bad_dir)
        error = ""
    except RuleError as exc:
        error = str(exc)
    print(f"  unquoted glob -> {error}")
    lab.check("quote globs" in error, "an unquoted glob starting with * is a YAML error, caught with a fix-it hint")


if __name__ == "__main__":
    main()
