"""D1.6 - Choosing a decomposition strategy before you start.

    prompt chaining         the steps are known up front and the inputs are enumerable
                            (review each file, then an integration pass)
    dynamic decomposition   what you find decides what you do next
                            (map, prioritize, re-plan as dependencies surface)

The decision is about the *task*, not the model: ask whether intermediate findings can
create new work. If they can, a fixed pipeline will either miss that work or do useless steps.

Run:  python choose_strategy.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

PROMPT_CHAINING = "prompt_chaining"
DYNAMIC = "dynamic_decomposition"


def choose_strategy(task: dict[str, Any]) -> tuple[str, str]:
    """task has: fixed_steps (sequence known before starting), bounded_scope (inputs can be listed
    up front, e.g. the files of a PR), findings_create_work (results can add or reorder subtasks)."""
    if task["findings_create_work"]:
        return DYNAMIC, "intermediate findings add or reorder subtasks, so the plan must adapt"
    if not task["bounded_scope"]:
        return DYNAMIC, "the scope is open-ended; map it first, then decide what to do"
    if task["fixed_steps"]:
        return PROMPT_CHAINING, "predictable steps over a known set of inputs; a fixed pipeline gives consistent depth"
    return DYNAMIC, "no fixed sequence of steps is known up front"


EXAMPLES: list[dict[str, Any]] = [
    {"task": "Review PR #1482 (4 files) for bugs, error handling and cross-file breakage",
     "fixed_steps": True, "bounded_scope": True, "findings_create_work": False, "expected": PROMPT_CHAINING},
    {"task": "Add comprehensive tests to the legacy_shop codebase",
     "fixed_steps": False, "bounded_scope": True, "findings_create_work": True, "expected": DYNAMIC},
    {"task": "Find out why checkout latency doubled since Tuesday's deploy",
     "fixed_steps": False, "bounded_scope": False, "findings_create_work": True, "expected": DYNAMIC},
    {"task": "Write release notes: summarize each of 30 merged PRs, then group them by product area",
     "fixed_steps": True, "bounded_scope": True, "findings_create_work": False, "expected": PROMPT_CHAINING},
    {"task": "Audit every API endpoint against a fixed checklist (auth, validation, rate limits)",
     "fixed_steps": True, "bounded_scope": True, "findings_create_work": False, "expected": PROMPT_CHAINING},
    {"task": "Find every path where customer PII can reach the logs and fix it",
     "fixed_steps": False, "bounded_scope": False, "findings_create_work": True, "expected": DYNAMIC},
]


def main() -> None:
    lab.banner("D1.6  choose_strategy(): prompt chaining vs dynamic decomposition")
    lab.section("Decisions")
    results = []
    for example in EXAMPLES:
        strategy, reason = choose_strategy(example)
        results.append(strategy == example["expected"])
        print(f"- {example['task']}\n    -> {strategy}: {reason}")
    lab.check(all(results), "every example task got the expected strategy")
    lab.check(choose_strategy(EXAMPLES[0])[0] == PROMPT_CHAINING, "multi-file PR review -> prompt chaining (see pr_review_chain.py)")
    lab.check(choose_strategy(EXAMPLES[1])[0] == DYNAMIC, "'add tests to a legacy codebase' -> dynamic decomposition (see adaptive_test_plan.py)")


if __name__ == "__main__":
    main()
