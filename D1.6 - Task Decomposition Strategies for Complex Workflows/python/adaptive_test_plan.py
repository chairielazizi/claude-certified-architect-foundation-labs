"""D1.6 (b) - Dynamic adaptive decomposition: "add comprehensive tests to a legacy codebase".

    1. map structure        code: import graph, fan-in, existing tests, criticality tags
    2. find high impact     impact = 2*fan_in + criticality + (no tests yet)
    3. prioritized plan     planner model call -> JSON task list
    4. execute + adapt      worker model call per task; a worker that hits a missing
                            dependency (DB fake, clock, HTTP stub) reports it, and the
                            planner inserts a fixture task, attaches it to every task that
                            will need it, and re-prioritizes. Repeat until the plan is done.

Nobody could write the final task list up front: the fixtures it contains were discovered by
running the earlier tasks. That is the difference from the fixed pipeline in pr_review_chain.py.

Run:  python adaptive_test_plan.py          (offline, scripted planner + worker)
      python adaptive_test_plan.py --live   (real Claude API, structured JSON outputs)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from choose_strategy import EXAMPLES, choose_strategy  # noqa: E402
from code_analysis import FIXTURES, map_repo, read_dir  # noqa: E402
from scripted_models import scripted_model  # noqa: E402

REPO = FIXTURES / "legacy_shop"
SAFETY_MAX_STEPS = 40  # runaway guard; hitting it is a bug

PLANNER_SYSTEM = (
    "TEST PLANNER. You plan how to add comprehensive tests to a legacy codebase. Given the repo map "
    "(imports, fan-in, criticality, existing tests) produce a prioritized task list: write_tests tasks for "
    "high-impact untested modules first. When STATE contains a discovery (a task was blocked by a missing "
    "test dependency), return the revised list of pending tasks: add a build_fixture task for each missing "
    "fixture (reuse existing fixture tasks), add it to depends_on of every pending task that will need it, "
    "and re-prioritize (1 = run first)."
)
WORKER_SYSTEM = (
    "TEST WORKER. You write unit tests for one module, or build one shared test fixture. If testing the "
    "module needs a fixture that is not in available_fixtures (a DB fake, a frozen clock, an HTTP or SMTP "
    "stub), do not write brittle tests: return status 'blocked' and list each missing fixture in snake_case "
    "with the reason."
)

TASK = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "kind": {"type": "string", "enum": ["write_tests", "build_fixture"]},
        "target": {"type": "string"},
        "priority": {"type": "integer"},
        "depends_on": {"type": "array", "items": {"type": "string"}},
        "reason": {"type": "string"},
    },
    "required": ["id", "kind", "target", "priority", "depends_on", "reason"],
    "additionalProperties": False,
}
PLAN_SCHEMA = {
    "type": "object",
    "properties": {"tasks": {"type": "array", "items": TASK}, "notes": {"type": "string"}},
    "required": ["tasks", "notes"],
    "additionalProperties": False,
}
WORKER_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["done", "blocked"]},
        "tests_written": {"type": "array", "items": {"type": "string"}},
        "missing": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"fixture": {"type": "string"}, "reason": {"type": "string"}},
                "required": ["fixture", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["status", "tests_written", "missing"],
    "additionalProperties": False,
}


def ask_json(client: Any, system: str, state: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": f"STATE:\n{json.dumps(state, indent=2)}"}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    return json.loads(lab.text_of(response))


def show_plan(version: int, tasks: list[dict[str, Any]]) -> None:
    parts = []
    for t in sorted(tasks, key=lambda t: t["priority"]):
        after = f" [after {','.join(t['depends_on'])}]" if t["depends_on"] else ""
        parts.append(f"{t['id']} {t['kind'].replace('_', ' ')} {t['target']}{after}")
    print(f"  [plan v{version}] " + "\n              ".join(parts))


def run_adaptive_plan(client: Any, repo_map: dict[str, Any], sources: dict[str, str]) -> dict[str, Any]:
    plan = ask_json(client, PLANNER_SYSTEM, {"repo_map": repo_map}, PLAN_SCHEMA)
    initial = [dict(t) for t in plan["tasks"]]
    print(f"  planner: {plan['notes']}")
    show_plan(1, initial)

    pending, done, log = [dict(t) for t in plan["tasks"]], [], []
    blocked_events, planner_calls, version = [], 1, 1
    for _ in range(SAFETY_MAX_STEPS):
        if not pending:
            return {"initial": initial, "done": done, "log": log, "blocked": blocked_events, "planner_calls": planner_calls}
        done_ids = {t["id"] for t in done}
        runnable = [t for t in pending if all(d in done_ids for d in t["depends_on"])]
        if not runnable:
            raise RuntimeError(f"Plan deadlocked: {[(t['id'], t['depends_on']) for t in pending]}")
        task = min(runnable, key=lambda t: (t["priority"], t["id"]))

        available = [t["target"] for t in done if t["kind"] == "build_fixture"]
        source = sources.get(task["target"], "")
        result = ask_json(client, WORKER_SYSTEM, {"task": task, "source": source, "available_fixtures": available}, WORKER_SCHEMA)
        log.append({"task": task["id"], "target": task["target"], "status": result["status"]})

        if result["status"] == "done":
            print(f"  run {task['id']} {task['target']}: done -> {len(result['tests_written'])} test(s)")
            pending.remove(task)
            done.append(task)
            continue

        # Blocked: the discovery goes back to the planner, which revises the remaining plan.
        missing = ", ".join(m["fixture"] for m in result["missing"])
        print(f"  run {task['id']} {task['target']}: BLOCKED, needs {missing}")
        blocked_events.append({"task": task["id"], "target": task["target"], "missing": result["missing"]})
        discovery = {"task_id": task["id"], "target": task["target"], "missing": result["missing"]}
        plan = ask_json(client, PLANNER_SYSTEM, {"repo_map": repo_map, "done": done, "pending": pending, "discovery": discovery}, PLAN_SCHEMA)
        planner_calls += 1
        version += 1
        pending = [t for t in plan["tasks"] if t["id"] not in done_ids]
        print(f"  planner: {plan['notes']}")
        show_plan(version, pending)
    raise RuntimeError(f"Plan did not finish in {SAFETY_MAX_STEPS} steps")


def main() -> None:
    lab.banner("D1.6  Dynamic decomposition: adaptive test plan for a legacy codebase")
    strategy, reason = choose_strategy(EXAMPLES[1])
    print(f"task: {EXAMPLES[1]['task']}\nstrategy: {strategy} ({reason})")

    lab.section("1-2. Map structure and score impact")
    repo_map = map_repo(REPO)
    print(f"  {'module':<17}{'fan-in':>7}{'crit':>8}{'tests':>7}{'impact':>8}   imports")
    for name, m in sorted(repo_map.items(), key=lambda kv: -kv[1]["impact"]):
        print(f"  {name:<17}{m['fan_in']:>7}{m['criticality']:>8}{'yes' if m['has_tests'] else 'no':>7}{m['impact']:>8}   {', '.join(m['imports']) or '-'}")

    lab.section("3-4. Plan, execute, discover, re-plan")
    client = lab.get_client(scripted_model)
    run = run_adaptive_plan(client, repo_map, read_dir(REPO))

    lab.section("Checks")
    order = [t["id"] for t in run["done"]]
    position = {tid: i for i, tid in enumerate(order)}
    lab.check(all(position[d] < position[t["id"]] for t in run["done"] for d in t["depends_on"]), "every task ran after all of its dependencies")
    lab.check(run["planner_calls"] == 1 + len(run["blocked"]), "the planner was consulted again after every blocking discovery")
    if not lab.is_live():
        initial_targets = [t["target"] for t in run["initial"]]
        impacts = [repo_map[t]["impact"] for t in initial_targets]
        lab.check(impacts == sorted(impacts, reverse=True) and "utils.py" not in initial_targets, "initial plan: untested modules by impact, utils.py skipped (has tests)")
        added = [t for t in run["done"] if t["id"] not in {i["id"] for i in run["initial"]}]
        lab.check(len(added) == 5 and all(t["kind"] == "build_fixture" for t in added), "the plan adapted: 5 fixture tasks were discovered and inserted")
        blocked_targets = {b["target"] for b in run["blocked"]}
        lab.check(
            {"models.py", "reports.py"}.isdisjoint(blocked_targets),
            "one discovery re-planned other tasks: models.py and reports.py waited for fake_db and were never blocked",
        )
        lab.check(len(run["done"]) == len(run["initial"]) + len(added), "every planned and discovered task completed")


if __name__ == "__main__":
    main()
