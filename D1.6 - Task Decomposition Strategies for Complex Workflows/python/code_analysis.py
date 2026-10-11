"""Small, regex-based reading of the fixture Python files (identical logic in codeAnalysis.ts).

Two users:
  * the deterministic "map the structure" step of the adaptive plan (import graph, fan-in,
    existing tests, criticality tags) - in a real agent this is Glob/Grep/Read tool work;
  * the scripted reviewers, as their way of "reading" code offline. They can only analyse
    what is in their prompt, which is exactly why a per-file pass cannot see a cross-file bug.

Regex, not `ast`, so the TypeScript twin can do the same thing with the same results.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

# Local (single-file) review rules the scripted reviewer applies.
LOCAL_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^\s*except\s*:\s*$"), "bare `except:` swallows every error (TypeError included) and hides the cause"),
    (re.compile(r"^def \w+\(.*=\s*(\[\]|\{\})"), "mutable default argument is shared between calls (and mutated here)"),
    (re.compile(r"\bif \w+ <= len\("), "off-by-one: index == len(...) passes the check, then raises IndexError"),
]


def read_dir(directory: Path) -> dict[str, str]:
    """name -> source for the top-level .py files of a directory, sorted by name."""
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(directory.glob("*.py"))}


def module_docstring(source: str) -> str:
    match = re.search(r'^"""(.*?)(?:"""|$)', source, re.M)
    return match.group(1).strip() if match else ""


def parse_imports(source: str) -> list[tuple[str, list[str]]]:
    """[(module, [imported names])]; `import x` gives (x, [])."""
    found: list[tuple[str, list[str]]] = []
    for line in source.splitlines():
        if m := re.match(r"^from (\w+) import (.+)$", line):
            found.append((m.group(1), [n.strip() for n in m.group(2).split(",")]))
        elif m := re.match(r"^import (\w+)\s*$", line):
            found.append((m.group(1), []))
    return found


def split_args(text: str) -> list[str]:
    """Split on top-level commas (ignores commas inside brackets and quotes)."""
    parts: list[str] = []
    depth, quote, current = 0, "", ""
    for ch in text:
        if quote:
            quote = "" if ch == quote else quote
        elif ch in "\"'":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(current.strip())
            current = ""
            continue
        current += ch
    if current.strip():
        parts.append(current.strip())
    return parts


def parse_defs(source: str) -> list[dict[str, Any]]:
    """Top-level functions: name, raw params and the signature string."""
    return [
        {"name": m.group(1), "params": split_args(m.group(2)), "signature": f"{m.group(1)}({m.group(2)})"}
        for m in re.finditer(r"^def (\w+)\((.*)\):", source, re.M)
    ]


def parse_classes(source: str) -> list[str]:
    return re.findall(r"^class (\w+)", source, re.M)


def extract_calls(source: str, name: str) -> list[str]:
    """Argument text of every call `name(...)`, with balanced parentheses (definitions skipped)."""
    calls: list[str] = []
    for m in re.finditer(rf"\b{re.escape(name)}\(", source):
        if source[max(0, m.start() - 4) : m.start()] == "def ":
            continue
        depth, i = 1, m.end()
        while i < len(source) and depth:
            depth += {"(": 1, ")": -1}.get(source[i], 0)
            i += 1
        calls.append(source[m.end() : i - 1])
    return calls


def check_call(args: list[str], params: list[str]) -> list[str]:
    """Problems with calling a function declared with `params` using `args`."""
    names = [p.split("=")[0].strip() for p in params]
    required = [n for p, n in zip(params, names) if "=" not in p and not n.startswith("*")]
    keyword = [m.group(1) for a in args if (m := re.match(r"^(\w+)\s*=(?!=)", a))]
    positional = [a for a in args if not re.match(r"^\w+\s*=(?!=)", a)]
    problems = []
    if len(positional) > len(names):
        problems.append(f"{len(positional)} positional args for {len(names)} params")
    problems += [f"unknown keyword '{k}'" for k in keyword if k not in names]
    supplied = set(names[: len(positional)]) | set(keyword)
    problems += [f"missing required '{r}'" for r in required if r not in supplied]
    return problems


def local_issues(source: str) -> list[dict[str, Any]]:
    issues = []
    for lineno, line in enumerate(source.splitlines(), start=1):
        for rule, message in LOCAL_RULES:
            if rule.search(line):
                issues.append({"line": lineno, "issue": message})
    return issues


# ---------------------------------------------------------------------------
# Structure mapping for the adaptive test plan
# ---------------------------------------------------------------------------

CRITICALITY_WEIGHT = {"high": 6, "medium": 3, "low": 1}


def impact_score(module: dict[str, Any]) -> int:
    """Fan-in (how much depends on it) + business criticality + 'has no tests yet'."""
    return module["fan_in"] * 2 + CRITICALITY_WEIGHT.get(module["criticality"], 1) + (0 if module["has_tests"] else 4)


def map_repo(repo: Path) -> dict[str, dict[str, Any]]:
    """module file -> imports, external deps, fan-in, criticality tag, existing tests, impact."""
    sources = read_dir(repo)
    stems = {Path(n).stem for n in sources}
    tested = {p.stem.removeprefix("test_") for p in (repo / "tests").glob("test_*.py")}
    info: dict[str, dict[str, Any]] = {}
    for name, source in sources.items():
        modules = [mod for mod, _ in parse_imports(source)]
        tag = re.search(r"#\s*criticality:\s*(\w+)", source)
        info[name] = {
            "imports": sorted(f"{m}.py" for m in set(modules) if m in stems),
            "external": sorted(m for m in set(modules) if m not in stems),
            "criticality": tag.group(1) if tag else "low",
            "has_tests": Path(name).stem in tested,
            "functions": [d["name"] for d in parse_defs(source)],
        }
    for name, module in info.items():
        module["fan_in"] = sum(1 for other in info.values() if name in other["imports"])
        module["impact"] = impact_score(module)
    return info
