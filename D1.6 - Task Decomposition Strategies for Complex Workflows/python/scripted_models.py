"""Offline stand-ins for Claude in the D1.6 demos (one responder per role, chosen by system prompt).

All of them are model-driven: they only use what is in the request they receive. That is
what makes the demos honest. The per-file reviewer cannot flag a cross-file bug because the
other file is not in its prompt, and the planner can only re-plan from discoveries it is shown.

Roles:
  per-file reviewer      one file in -> local issues, exports, outgoing calls (JSON)
  integration reviewer   per-file reports in -> cross-file mismatches (JSON)
  single-pass reviewer   every file in one prompt; simulates attention dilution (sample Q12)
  test planner           repo map (+ discoveries) in -> prioritized task plan (JSON)
  test worker            one module + available fixtures in -> done | blocked + missing (JSON)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from code_analysis import (  # noqa: E402
    check_call,
    extract_calls,
    local_issues,
    module_docstring,
    parse_classes,
    parse_defs,
    parse_imports,
    split_args,
)

# Simulated attention budget for the single-pass reviewer: files after the first two get a
# skim. Real dilution is not a hard cutoff, it is inconsistent depth, but the effect on the
# output (some files reviewed well, obvious bugs missed elsewhere) is the same.
SINGLE_PASS_DEEP_FILES = 2

FILE_BLOCK = re.compile(r"^### FILE: (\S+)\n(.*?)^### END FILE", re.M | re.S)


def files_in(prompt: str) -> dict[str, str]:
    return {m.group(1): m.group(2) for m in FILE_BLOCK.finditer(prompt)}


def _json_reply(payload: dict[str, Any]) -> lab.Obj:
    # Matches what output_config json_schema guarantees in live mode: one JSON text block.
    return lab.message(lab.text(json.dumps(payload)))


def _json_after(marker: str, prompt: str) -> Any:
    return json.loads(prompt.split(marker, 1)[1].strip())


# ---------------------------------------------------------------------------
# Reviewers (part a)
# ---------------------------------------------------------------------------


def per_file_review(name: str, source: str) -> dict[str, Any]:
    defs = parse_defs(source)
    local_names = {d["name"] for d in defs}
    calls, unverifiable = [], []
    for module, names in parse_imports(source):
        for symbol in names:
            for args in extract_calls(source, symbol):
                calls.append({"symbol": symbol, "module": module, "call": f"{symbol}({args})"})
                if symbol not in local_names:
                    unverifiable.append(f"{module}.{symbol}")
    summary = module_docstring(source) or f"{name} module"
    if unverifiable:
        # Honest limit of a focused pass: the callee's signature is not in this prompt.
        summary += f" Calls {', '.join(sorted(set(unverifiable)))} (signature not visible in this file)."
    return {
        "file": name,
        "summary": summary,
        "local_issues": local_issues(source),
        "exports": [d["signature"] for d in defs] + [f"class {c}" for c in parse_classes(source)],
        "external_calls": calls,
    }


def integration_review(reports: list[dict[str, Any]]) -> dict[str, Any]:
    # Interface table built only from what the per-file passes exported.
    signatures: dict[tuple[str, str], tuple[str, list[str]]] = {}
    for report in reports:
        module = report["file"].removesuffix(".py")
        for sig in report["exports"]:
            if m := re.match(r"^(\w+)\((.*)\)$", sig):
                signatures[(module, m.group(1))] = (sig, split_args(m.group(2)))

    issues = []
    for report in reports:
        hides_errors = any("bare `except:`" in i["issue"] for i in report["local_issues"])
        for call in report["external_calls"]:
            known = signatures.get((call["module"], call["symbol"]))
            if known is None:
                continue
            signature, params = known
            args = split_args(extract_calls(call["call"], call["symbol"])[0])
            problems = check_call(args, params)
            if problems:
                text = (
                    f"{report['file']} calls {call['call']} but {call['module']}.py now defines "
                    f"{signature}: {'; '.join(problems)}. This raises TypeError at runtime"
                )
                text += f", which {report['file']}'s bare except turns into a silent 500." if hides_errors else "."
                issues.append({"caller": report["file"], "callee": f"{call['module']}.{call['symbol']}", "issue": text})
    return {"cross_file_issues": issues}


def single_pass_review(files: dict[str, str]) -> dict[str, Any]:
    findings = []
    for index, (name, source) in enumerate(files.items()):
        if index < SINGLE_PASS_DEEP_FILES:
            findings += [{"file": name, "issue": i["issue"]} for i in local_issues(source)]
        else:
            findings.append({"file": name, "issue": "Looks fine."})  # superficial skim
    return {"findings": findings}


# ---------------------------------------------------------------------------
# Planner and worker (part b)
# ---------------------------------------------------------------------------

# How the worker recognises what a test for a module needs (it reads the source).
FIXTURE_HINTS: list[tuple[str, str, str]] = [
    (r"\bsqlite3\.connect\(", "tmp_sqlite", "opens a real sqlite file; tests need a temporary database"),
    (r"\bdb\.connect\(", "fake_db", "calls db.connect(); tests need an in-memory DB fake"),
    (r"\brequests\.(post|get)\(", "gateway_stub", "calls the payment gateway over HTTP; tests need a stub"),
    (r"\bdatetime\.now\(", "frozen_clock", "depends on the current time; tests need a frozen clock"),
    (r"\bsmtplib\.SMTP\(", "smtp_stub", "opens an SMTP connection; tests need a stub mail server"),
]

# How the planner generalises a discovery to modules that have not run yet (from the repo map).
FIXTURE_SIGNALS = {
    "tmp_sqlite": lambda m: "sqlite3" in m["external"],
    "fake_db": lambda m: "db.py" in m["imports"],
    "gateway_stub": lambda m: "requests" in m["external"],
    "frozen_clock": lambda m: "datetime" in m["external"],
    "smtp_stub": lambda m: "smtplib" in m["external"],
}


def _prioritize(tasks: list[dict[str, Any]], repo_map: dict[str, Any]) -> list[dict[str, Any]]:
    """Fixtures first (most dependents first), then modules by impact; renumber priorities."""

    def dependents(task: dict[str, Any]) -> int:
        return sum(1 for t in tasks if task["id"] in t["depends_on"])

    def key(task: dict[str, Any]) -> tuple[int, int, str]:
        if task["kind"] == "build_fixture":
            return (0, -dependents(task), task["target"])
        return (1, -repo_map[task["target"]]["impact"], task["target"])

    ordered = sorted(tasks, key=key)
    for rank, task in enumerate(ordered, start=1):
        task["priority"] = rank
    return ordered


def initial_plan(repo_map: dict[str, Any]) -> dict[str, Any]:
    targets = [name for name, m in repo_map.items() if not m["has_tests"]]
    skipped = [name for name, m in repo_map.items() if m["has_tests"]]
    targets.sort(key=lambda n: (-repo_map[n]["impact"], n))
    tasks = [
        {
            "id": f"T{i}",
            "kind": "write_tests",
            "target": name,
            "priority": i,
            "depends_on": [],
            "reason": f"impact {repo_map[name]['impact']}: fan-in {repo_map[name]['fan_in']}, "
            f"criticality {repo_map[name]['criticality']}, no tests",
        }
        for i, name in enumerate(targets, start=1)
    ]
    return {"tasks": tasks, "notes": f"Skipped {', '.join(skipped)} (already has tests)."}


def replan(state: dict[str, Any]) -> dict[str, Any]:
    repo_map, pending, done = state["repo_map"], [dict(t) for t in state["pending"]], state["done"]
    discovery = state["discovery"]
    known = {t["target"]: t["id"] for t in pending if t["kind"] == "build_fixture"}
    known.update({t["target"]: t["id"] for t in done if t["kind"] == "build_fixture"})
    next_f = 1 + sum(1 for t in pending + done if t["kind"] == "build_fixture")
    notes = []
    for missing in discovery["missing"]:
        fixture = missing["fixture"]
        if fixture not in known:
            known[fixture] = f"F{next_f}"
            next_f += 1
            pending.append(
                {"id": known[fixture], "kind": "build_fixture", "target": fixture, "priority": 0, "depends_on": [],
                 "reason": f"discovered while testing {discovery['target']}: {missing['reason']}"}
            )
        # Generalise: every pending module with the same signal will need this fixture too.
        signal = FIXTURE_SIGNALS.get(fixture, lambda m: False)
        affected = []
        for task in pending:
            if task["kind"] != "write_tests":
                continue
            needs = task["target"] == discovery["target"] or signal(repo_map[task["target"]])
            if needs and known[fixture] not in task["depends_on"]:
                task["depends_on"] = task["depends_on"] + [known[fixture]]
                affected.append(task["target"])
        notes.append(f"{known[fixture]} {fixture} now blocks {', '.join(affected) or 'nothing new'}")
    return {"tasks": _prioritize(pending, repo_map), "notes": "; ".join(notes)}


def worker(task: dict[str, Any], source: str, available: list[str]) -> dict[str, Any]:
    if task["kind"] == "build_fixture":
        return {"status": "done", "tests_written": [f"tests/conftest.py::{task['target']}"], "missing": []}
    needs = [(fixture, reason) for pattern, fixture, reason in FIXTURE_HINTS if re.search(pattern, source)]
    missing = [{"fixture": f, "reason": f"{task['target']} {r}"} for f, r in needs if f not in available]
    if missing:
        return {"status": "blocked", "tests_written": [], "missing": missing}
    module = task["target"].removesuffix(".py")
    tests = [f"tests/test_{module}.py::test_{d['name']}" for d in parse_defs(source)]
    return {"status": "done", "tests_written": tests, "missing": []}


# ---------------------------------------------------------------------------
# The responder: dispatch on the system prompt, read only the request
# ---------------------------------------------------------------------------


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    system = lab.system_text(params)
    prompt = lab.last_user_text(params)
    if system.startswith("PER-FILE REVIEWER"):
        ((name, source),) = files_in(prompt).items()  # exactly one file by construction
        return _json_reply(per_file_review(name, source))
    if system.startswith("INTEGRATION REVIEWER"):
        return _json_reply(integration_review(_json_after("PER-FILE REPORTS:", prompt)))
    if system.startswith("SINGLE-PASS REVIEWER"):
        return _json_reply(single_pass_review(files_in(prompt)))
    if system.startswith("TEST PLANNER"):
        state = _json_after("STATE:", prompt)
        return _json_reply(replan(state) if state.get("discovery") else initial_plan(state["repo_map"]))
    if system.startswith("TEST WORKER"):
        state = _json_after("STATE:", prompt)
        return _json_reply(worker(state["task"], state["source"], state["available_fixtures"]))
    raise RuntimeError(f"No scripted role for system prompt: {system[:40]!r}")
