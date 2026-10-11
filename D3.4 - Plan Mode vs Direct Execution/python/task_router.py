"""D3.4 - Plan mode or direct execution? Explicit criteria instead of gut feel.

    plan mode         large or multi-file change, architectural / service-boundary decisions, several
                      valid approaches, approaches that differ in infrastructure, unclear requirements
                      -> explore and design safely first (read-only), then execute the approved plan
    direct execution  well-scoped change with clear requirements: a single-file fix with a clear stack
                      trace, adding one validation conditional -> planning adds overhead, not safety

The complexity is usually KNOWN UP FRONT (it is in the task description). "Start direct and switch to
plan mode if it gets hard" means discovering the dependencies after you have already edited files.

Run:  python task_router.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

MULTI_FILE_THRESHOLD = 3  # more files than this = a multi-file change whose dependencies need mapping


@dataclass
class Task:
    description: str
    estimated_files: int
    architectural_decision: bool = False  # service boundaries, module dependencies, data ownership
    multiple_valid_approaches: bool = False
    infrastructure_choice: bool = False  # the options differ in infrastructure (queues, new services, DBs)
    requirements_clear: bool = True
    clear_stack_trace: bool = False
    single_function: bool = False


@dataclass
class Route:
    mode: str  # "plan mode" | "direct execution"
    reasons: list[str] = field(default_factory=list)
    next_step: str = ""


def route(task: Task) -> Route:
    plan_signals = []
    if task.estimated_files > MULTI_FILE_THRESHOLD:
        plan_signals.append(f"~{task.estimated_files} files: a multi-file change; map dependencies before editing")
    if task.architectural_decision:
        plan_signals.append("architectural decision (service boundaries / module dependencies)")
    if task.multiple_valid_approaches:
        plan_signals.append("several valid approaches: compare them before committing to one")
    if task.infrastructure_choice:
        plan_signals.append("the approaches need different infrastructure: decide before building")
    if not task.requirements_clear:
        plan_signals.append("requirements are unclear: investigate and clarify first")
    if plan_signals:
        return Route(
            "plan mode",
            plan_signals,
            "explore read-only (Explore subagent for verbose discovery), then directly execute the approved plan",
        )
    reasons = []
    if task.clear_stack_trace:
        reasons.append("a clear stack trace pinpoints the failure")
    if task.single_function:
        reasons.append("the change is confined to one function")
    reasons.append(f"well-scoped ({task.estimated_files} file(s)) with clear requirements: planning adds overhead, not safety")
    return Route("direct execution", reasons, "make the change, run the tests")


# The exam's own examples (task statement 3.4 and sample question 5), plus two boundary cases.
EXAMPLES: list[tuple[Task, str]] = [
    (Task("Restructure the monolith into microservices", 60, architectural_decision=True, multiple_valid_approaches=True), "plan mode"),
    (Task("Migrate from moment to date-fns (library migration, 45+ files)", 47, multiple_valid_approaches=True), "plan mode"),
    (
        Task("Integrate the payment provider: polling job vs webhook endpoint + queue", 8, multiple_valid_approaches=True, infrastructure_choice=True),
        "plan mode",
    ),
    (Task("Fix TypeError in parse_invoice (stack trace points at invoices.py:42)", 1, clear_stack_trace=True, single_function=True), "direct execution"),
    (Task("Add a date validation conditional: reject due_date before issue_date", 1, single_function=True), "direct execution"),
    (Task("Checkout 'sometimes' fails for some users; no reproduction yet", 2, requirements_clear=False), "plan mode"),
    (Task("Rename an internal helper used in 3 files", 3), "direct execution"),
]


def main() -> None:
    lab.banner("D3.4  Task router: plan mode vs direct execution")
    results = []
    for task, expected in EXAMPLES:
        decision = route(task)
        results.append((task, decision, expected))
        print(f"\n  {task.description}\n    -> {decision.mode.upper()}")
        for reason in decision.reasons:
            print(f"       - {reason}")
        print(f"       next: {decision.next_step}")

    lab.section("Checks")
    lab.check(all(d.mode == expected for _, d, expected in results), "every exam example is routed as the exam expects")
    monolith = results[0][1]
    lab.check(any("architectural" in r for r in monolith.reasons), "sample Q5: microservices restructuring -> plan mode, because of the architectural decisions")
    lab.check(all("approved plan" in d.next_step for _, d, _ in results if d.mode == "plan mode"), "plan-mode tasks continue with direct execution of the approved plan")
    unclear = route(Task("Make the daily report faster (cause unknown)", 1, requirements_clear=False))
    lab.check(unclear.mode == "plan mode", "file count alone doesn't decide: an unclear one-file task still needs investigation first")


if __name__ == "__main__":
    main()
