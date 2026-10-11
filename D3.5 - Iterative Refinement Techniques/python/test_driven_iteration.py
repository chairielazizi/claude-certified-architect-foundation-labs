"""D3.5 - Test-driven iteration: write the tests first, then iterate by sharing the failures.

    tests (expected behavior + null/missing edge cases + a performance requirement)  <- written FIRST
    loop (bounded):
        Claude writes / revises the module
        run the tests in a SUBPROCESS with a timeout          (never exec model code in-process)
        collect failures as (input, expected, actual)
        send every failure back, with the current code
    until green

Run:  python test_driven_iteration.py          (offline: scripted revisions)
      python test_driven_iteration.py --live   (real Claude writes the code; tests still run locally)
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from scripted_fixes import MONEY_TEST, scripted_claude  # noqa: E402

HERE = Path(__file__).resolve().parent
RUNTIME = HERE.parent / ".lab-runtime" / "tdd"
HARNESS = HERE / "migration_harness.py"
TESTS = HERE / "migration_tests.py"
MAX_ROUNDS = 5  # a bound, not the stop signal: the loop stops when the tests pass
TEST_TIMEOUT_S = 30

SYSTEM = (
    "You are implementing a data-migration module. Reply with the complete module in a single ```python "
    "block, followed by one line saying what you changed. Keep the function signatures exactly as specified."
)


def first_prompt(tests_source: str) -> str:
    return (
        "Implement migration.py so that this test suite passes. The tests were written first and ARE the "
        "specification, including the null/missing-value cases and the performance requirement.\n\n"
        f"```python\n{tests_source}```"
    )


def fix_prompt(code: str, failures: list[dict[str, Any]]) -> str:
    lines = [
        "The test suite still fails. Below is your current module and every failing test with its input, "
        "the expected output and what your code actually returned. Fix all of them in one revision.",
        "",
        "Current module:",
        f"```python\n{code}```",
        "",
        "Failing tests:",
    ]
    for failure in failures:
        lines += [
            f"- {failure['name']}",
            f"    input:    {json.dumps(failure['input'])}",
            f"    expected: {json.dumps(failure['expected'])}",
            f"    actual:   {failure.get('error') or json.dumps(failure['actual'])}",
        ]
    return "\n".join(lines)


def extract_code(reply: str) -> str:
    match = re.search(r"```python\n(.*?)```", reply, re.S)
    if not match:
        raise RuntimeError("Claude's reply had no ```python block")
    return match.group(1)


def run_tests(candidate: Path) -> list[dict[str, Any]]:
    """Run the suite against `candidate` in a separate interpreter with a timeout."""
    try:
        proc = subprocess.run(
            [sys.executable, "-I", str(HARNESS), str(candidate)],
            capture_output=True, text=True, timeout=TEST_TIMEOUT_S, stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return [{"name": "whole suite", "input": "-", "expected": f"finish within {TEST_TIMEOUT_S}s", "actual": "timed out", "passed": False}]
    report = json.loads(proc.stdout or "{}")
    if report.get("import_error") or not report.get("results"):
        return [{"name": "module imports", "input": "-", "expected": "importable module", "actual": report.get("import_error", proc.stderr[-500:]), "passed": False}]
    return report["results"]


def main() -> None:
    lab.banner("D3.5  Test-driven iteration: tests first, then share failures until green")
    shutil.rmtree(RUNTIME, ignore_errors=True)
    tests_source = TESTS.read_text(encoding="utf-8")
    client = lab.get_client(scripted_claude)
    prompt = first_prompt(tests_source)
    rounds: list[dict[str, Any]] = []

    for round_number in range(1, MAX_ROUNDS + 1):
        response = client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=SYSTEM, messages=[{"role": "user", "content": prompt}]
        )
        reply = lab.text_of(response)
        code = extract_code(reply)
        candidate = RUNTIME / f"round{round_number}" / "migration.py"
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text(code, encoding="utf-8", newline="\n")

        results = run_tests(candidate)
        failures = [r for r in results if not r["passed"]]
        rounds.append({"prompt": prompt, "failures": failures, "total": len(results)})
        lab.section(f"Round {round_number}: {len(results) - len(failures)}/{len(results)} passing")
        print(f"  Claude: {reply.rsplit('```', 1)[-1].strip()}")
        for failure in failures:
            print(f"  FAIL {failure['name']}: {failure.get('error') or json.dumps(failure['actual'])}")
        if not failures:
            break
        prompt = fix_prompt(code, failures)

    lab.section("Checks")
    counts = [len(r["failures"]) for r in rounds]
    print(f"  failures per round: {counts}")
    lab.check(tests_source in rounds[0]["prompt"], "the test suite existed first and was the spec in the very first prompt")
    lab.check(counts[-1] == 0, f"the suite went green within the {MAX_ROUNDS}-round bound")
    lab.check("candidate" not in sys.modules, "model-written code ran only in the subprocess harness, never in this process")
    if not lab.is_live():
        lab.check(counts == [8, 1, 0], "each round's shared failures drove the next revision: 8 -> 1 -> 0")
        second = rounds[1]["prompt"]
        lab.check(
            "keeps a null phone as null" in second and '"phone": null' in second,
            "the null-value edge case was sent as a concrete input plus expected output",
        )
        third = rounds[2]["prompt"]
        lab.check(
            MONEY_TEST in third and "120434" in third and "120435" in third,
            "round 3 saw the exact actual (120434) vs expected (120435), which pinpoints the float bug",
        )


if __name__ == "__main__":
    main()
