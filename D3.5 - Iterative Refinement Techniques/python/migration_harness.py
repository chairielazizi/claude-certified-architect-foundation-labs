"""Run migration_tests.py against a candidate implementation and print the results as JSON.

This script is executed in a SUBPROCESS (python -I migration_harness.py <candidate.py>) by
test_driven_iteration.py. Model-written code is only ever imported here, in a separate interpreter
with a timeout, never inside the lab's own process.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir from sys.path
from migration_tests import CASES, COUNTRIES, PERF, BASE  # noqa: E402


def load(candidate: Path):
    spec = importlib.util.spec_from_file_location("candidate", candidate)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def error_text(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def main() -> None:
    results = []
    try:
        module = load(Path(sys.argv[1]))
    except Exception as exc:  # the candidate does not even import
        print(json.dumps({"import_error": error_text(exc), "trace": traceback.format_exc(limit=3), "results": []}))
        return

    for test in CASES:
        entry = {"name": test["name"], "input": test["input"], "expected": test["expected"]}
        try:
            actual = module.migrate_customer(copy.deepcopy(test["input"]), dict(COUNTRIES))
            entry |= {"actual": actual, "passed": actual == test["expected"]}
        except Exception as exc:
            entry |= {"actual": None, "error": error_text(exc), "passed": False}
        results.append(entry)

    loads = 0

    def load_countries() -> dict:
        nonlocal loads
        loads += 1
        return dict(COUNTRIES)

    records = [{**BASE, "id": str(i)} for i in range(PERF["records"])]
    entry = {"name": PERF["name"], "input": f"{PERF['records']} records", "expected": f"<= {PERF['max_loads']} table load(s), < {PERF['max_seconds']}s"}
    try:
        start = time.perf_counter()
        out = module.migrate_all(records, load_countries)
        elapsed = time.perf_counter() - start
        entry |= {
            "actual": f"{loads} table load(s), {elapsed:.2f}s, {len(out)} records",
            "passed": loads <= PERF["max_loads"] and elapsed < PERF["max_seconds"] and len(out) == PERF["records"],
        }
    except Exception as exc:
        entry |= {"actual": None, "error": error_text(exc), "passed": False}
    results.append(entry)
    print(json.dumps({"results": results}, default=str))


if __name__ == "__main__":
    main()
