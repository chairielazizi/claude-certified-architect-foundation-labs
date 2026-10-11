"""D1.2 - Hub-and-spoke coordinator: dynamic routing, partitioned delegation, iterative refinement.

    query -> plan()                coordinator's own LLM call: how complex? which subagents? which slices?
          -> validate_coverage()   programmatic check of the decomposition (see scope_partitioning.py)
          -> delegate(web_search | document_analysis)   one slice x one source type per call
          -> refine(): delegate(synthesis) -> structured gaps -> targeted re-delegation -> repeat
          -> delegate(report)

Every subagent call goes through Coordinator.delegate(): the one place that builds the
isolated request, writes the event log and applies the error policy.

Run:  python coordinator.py          (offline, scripted subagents)
      python coordinator.py --live   (every role is a real messages.create call)
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from coverage_validator import feedback_for, validate_coverage  # noqa: E402
from research_team import (  # noqa: E402
    COORDINATOR_PROMPT,
    OUTPUT_SCHEMAS,
    ROLES,
    SUBAGENT_PROMPTS,
    json_output,
    role_of,
    scripted_team,
)

MAX_PLAN_ATTEMPTS = 3
# Bounded refinement: if coverage is still short after this many synthesis passes, raise.
# Publishing a report with a silent hole is worse than failing loudly.
MAX_REFINEMENT_ROUNDS = 3

# Partitioning by source type: search and analysis never fetch the same kind of source.
SOURCE_TYPES = {
    "web_search": ("web", "news and web articles only; reports and papers are assigned to document_analysis"),
    "document_analysis": ("documents", "research reports and academic papers only; news is assigned to web_search"),
}
SHORT = {"web_search": "web", "document_analysis": "docs"}


@dataclass
class SubagentResult:
    role: str
    task_id: str
    ok: bool
    data: Any = None
    error: dict[str, Any] | None = None


class CoverageNotConverged(RuntimeError):
    def __init__(self, rounds: int, gaps: list[dict[str, Any]]):
        detail = ", ".join(f"{g['dimension']} ({g['missing']})" for g in gaps) or "synthesis never succeeded"
        super().__init__(f"coverage still insufficient after {rounds} refinement rounds: {detail}")
        self.rounds = rounds
        self.gaps = gaps


def classify_error(exc: BaseException) -> tuple[str, bool]:
    """Map any subagent failure to (error_type, retryable).

    Matching class names (not isinstance) keeps this working for SDK errors such as
    anthropic.RateLimitError or APITimeoutError without importing the SDK offline.
    """
    names = {cls.__name__ for cls in type(exc).__mro__}
    if names & {"TimeoutError", "APITimeoutError"}:
        return "timeout", True
    if names & {"RateLimitError", "APIConnectionError", "InternalServerError"}:
        return "transient", True
    if names & {"ValueError", "KeyError"}:  # includes json.JSONDecodeError: malformed output
        return "invalid_output", True
    return "unexpected", False


def citation(raw: dict[str, Any]) -> str:
    if "source_url" in raw:
        return f"{raw['title']}, {raw['source_url']} ({raw['publication_date']})"
    return f"{raw['document_name']}, p. {raw['page']} ({raw['publication_date']})"


def slice_task(topic: str, focus: str, role: str, note: str = "") -> str:
    lines = [f"<topic>{topic}</topic>", f"<slice>{focus}</slice>", f"<source_type>{SOURCE_TYPES[role][1]}</source_type>"]
    if note:
        lines.append(f"<note>{note}</note>")
    lines.append("Research only this slice and source type; other agents cover the rest. Return your findings as JSON.")
    return "\n".join(lines)


def synthesis_task(topic: str, required: list[str], findings: list[dict[str, Any]]) -> str:
    return "\n".join(
        [
            f"<topic>{topic}</topic>",
            f"<required_dimensions>{json.dumps(required)}</required_dimensions>",
            "<findings>",
            json.dumps(findings, indent=1),
            "</findings>",
            "Combine the findings into key points per dimension and report coverage gaps as JSON.",
        ]
    )


def report_task(topic: str, synthesis: dict[str, Any], findings: list[dict[str, Any]]) -> str:
    sources = [{"id": f["id"], "citation": f["citation"]} for f in findings]
    return "\n".join(
        [
            f"<topic>{topic}</topic>",
            f"<synthesis>{json.dumps(synthesis)}</synthesis>",
            f"<sources>{json.dumps(sources)}</sources>",
            "Write the final report.",
        ]
    )


def summarize(role: str, data: Any) -> str:
    if role in ("web_search", "document_analysis"):
        return f"{len(data['findings'])} finding(s)"
    if role == "synthesis":
        return f"{len(data['key_points'])} key point(s), {len(data['coverage_gaps'])} gap(s), sufficient={data['coverage_sufficient']}"
    return f"report, {len(str(data).splitlines())} lines"


class Coordinator:
    """The hub. Subagents never talk to each other; everything flows through these methods."""

    def __init__(self, client: Any) -> None:
        self.client = client
        self.history: list[dict[str, Any]] = []  # the coordinator's OWN conversation (planning turns)
        self.plans: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []  # observability: every plan, delegation and outcome
        self.subagent_requests: list[dict[str, Any]] = []  # exactly what each subagent was sent
        self.findings: list[dict[str, Any]] = []  # aggregated results, tagged by the coordinator

    def log(self, event: str, role: str, task_id: str, detail: str) -> None:
        self.events.append({"seq": len(self.events) + 1, "event": event, "role": role, "task": task_id, "detail": detail})

    # -- planning: decide complexity, route and decomposition -----------------

    def plan(self, query: str) -> dict[str, Any]:
        self.history = [{"role": "user", "content": query}]
        for attempt in range(1, MAX_PLAN_ATTEMPTS + 1):
            response = self.client.messages.create(
                model=lab.MODEL,
                max_tokens=16000,
                system=COORDINATOR_PROMPT,
                output_config=json_output("coordinator"),
                messages=self.history,
            )
            self.history.append({"role": "assistant", "content": response.content})
            plan = json.loads(lab.text_of(response))
            self.plans.append(plan)
            self.log(
                "plan", "coordinator", f"plan-{attempt}",
                f"{plan['complexity']}; route={plan['subagents']}; {len(plan['subtopics'])} slice(s)",
            )
            if plan["complexity"] == "simple":
                return plan
            coverage = validate_coverage(query, plan["subtopics"])
            verdict = "ok" if coverage["ok"] else f"missing={coverage['missing']} overlaps={coverage['overlaps']}"
            self.log("validate", "coordinator", f"plan-{attempt}", verdict)
            if coverage["ok"]:
                plan["coverage"] = coverage
                return plan
            # A too-narrow decomposition is the coordinator's bug, so the feedback goes to the coordinator,
            # not to the downstream agents (sample question 7).
            self.history.append({"role": "user", "content": feedback_for(coverage)})
        raise RuntimeError(f"No decomposition passed the coverage check in {MAX_PLAN_ATTEMPTS} attempts")

    # -- the single entry point for every subagent call -----------------------

    def delegate(self, role: str, task: str, task_id: str, detail: str) -> SubagentResult:
        params: dict[str, Any] = {
            "model": lab.MODEL,
            "max_tokens": 16000,
            "system": SUBAGENT_PROMPTS[role],
            # A fresh one-message conversation: the subagent sees its task and nothing else.
            # self.history is never passed; whatever a subagent needs must be written into `task`.
            "messages": [{"role": "user", "content": task}],
        }
        if role in OUTPUT_SCHEMAS:
            params["output_config"] = json_output(role)
        self.subagent_requests.append(params)
        self.log("delegate", role, task_id, detail)
        try:
            response = self.client.messages.create(**params)
            if response.stop_reason != "end_turn":
                raise ValueError(f"incomplete response (stop_reason={response.stop_reason})")
            data = json.loads(lab.text_of(response)) if role in OUTPUT_SCHEMAS else lab.text_of(response)
        except Exception as exc:  # noqa: BLE001 - one consistent policy for every subagent failure
            kind, retryable = classify_error(exc)
            error = {"role": role, "task_id": task_id, "type": kind, "retryable": retryable, "message": str(exc)[:160]}
            self.log("error", role, task_id, f"{kind} (retryable={retryable}): {error['message']}")
            return SubagentResult(role, task_id, ok=False, error=error)
        self.log("result", role, task_id, summarize(role, data))
        return SubagentResult(role, task_id, ok=True, data=data)

    def gather(self, topic: str, focus: str, role: str, dimension: str, task_id: str, note: str = "") -> SubagentResult:
        """Delegate one research assignment and aggregate its findings (the coordinator tags them)."""
        result = self.delegate(role, slice_task(topic, focus, role, note), task_id, focus)
        if result.ok:
            for raw in result.data["findings"]:
                self.findings.append(
                    {
                        "id": f"F{len(self.findings) + 1}",
                        "dimension": dimension,
                        "source_type": SOURCE_TYPES[role][0],
                        "claim": raw["claim"],
                        "citation": citation(raw),
                    }
                )
        return result

    # -- iterative refinement ----------------------------------------------------

    def refine(self, topic: str, required: list[str]) -> tuple[dict[str, Any], int]:
        """Synthesis judges coverage; the coordinator closes each gap with a targeted delegation."""
        gaps: list[dict[str, Any]] = []
        for round_ in range(1, MAX_REFINEMENT_ROUNDS + 1):
            synthesis = self.delegate(
                "synthesis", synthesis_task(topic, required, self.findings), f"synth-r{round_}",
                f"{len(self.findings)} findings",
            )
            if not synthesis.ok:
                continue  # already logged by delegate(); the next round retries synthesis
            if synthesis.data["coverage_sufficient"]:
                return synthesis.data, round_
            gaps = synthesis.data["coverage_gaps"]
            if round_ == MAX_REFINEMENT_ROUNDS:
                break  # no synthesis pass left to use new findings
            self.log(
                "refine", "coordinator", f"round-{round_}",
                "; ".join(f"{g['dimension']}: {g['missing']} -> {g['target_role']}" for g in gaps),
            )
            for n, gap in enumerate(gaps, 1):
                self.gather(
                    topic, gap["suggested_query"], gap["target_role"], gap["dimension"], f"gap-r{round_}.{n}",
                    note=f"Follow-up for a coverage gap in {gap['dimension']}: {gap['missing']}.",
                )
        raise CoverageNotConverged(MAX_REFINEMENT_ROUNDS, gaps)

    # -- the whole run -----------------------------------------------------------

    def research(self, query: str) -> dict[str, Any]:
        plan = self.plan(query)
        route = [role for role in ROLES if role in plan["subagents"]]  # dynamic selection, not a fixed pipeline
        coverage = plan.get("coverage", {})
        slice_dims = coverage.get("slice_dimensions", {})
        # Scope partitioning: one assignment per slice x source type, so no two calls overlap.
        for st in plan["subtopics"]:
            dimension = (slice_dims.get(st["id"]) or [st["id"]])[0]
            for role in ("web_search", "document_analysis"):
                if role in route:
                    self.gather(query, st["focus"], role, dimension, f"{st['id']}/{SHORT[role]}")

        outcome: dict[str, Any] = {"plan": plan, "route": route, "rounds": 0}
        if "synthesis" not in route:
            # Simple route: the coordinator answers straight from the search result.
            outcome["answer"] = " ".join(f"{f['claim']} [{f['citation']}]" for f in self.findings) or "No answer found."
            return outcome

        required = coverage.get("required") or sorted({f["dimension"] for f in self.findings})
        synthesis, outcome["rounds"] = self.refine(query, required)
        outcome["answer"] = json.dumps(synthesis, indent=2)
        if "report" in route:
            report = self.delegate("report", report_task(query, synthesis, self.findings), "report", "final report")
            if report.ok:
                outcome["answer"] = report.data
        return outcome


# ---------------------------------------------------------------------------
# Inspection helpers used by the demos' checks
# ---------------------------------------------------------------------------


def print_events(coordinator: Coordinator, keep: Callable[[dict[str, Any]], bool] | None = None) -> None:
    """Print the event log (optionally only the events `keep` selects)."""
    for e in coordinator.events:
        if keep is None or keep(e):
            print(f"  {e['seq']:02d} {e['event']:<8} {e['role']:<17} {e['task']:<10} {e['detail']}")


def isolation_violations(coordinator: Coordinator) -> list[str]:
    """Subagent requests that carry anything from the coordinator's own conversation."""
    private = [COORDINATOR_PROMPT] + [p["rationale"] for p in coordinator.plans]
    problems = []
    for req in coordinator.subagent_requests:
        blob = json.dumps(lab.to_plain(req), default=str)
        if len(req["messages"]) != 1:
            problems.append(f"{role_of(req)}: {len(req['messages'])} messages instead of 1")
        if any(p in blob for p in private):
            problems.append(f"{role_of(req)}: contains coordinator-private text")
    return problems


def unpaired_delegations(coordinator: Coordinator) -> bool:
    """True if any delegation lacks exactly one matching result/error event."""
    delegated = sorted(e["task"] for e in coordinator.events if e["event"] == "delegate")
    outcomes = sorted(e["task"] for e in coordinator.events if e["event"] in ("result", "error"))
    return delegated != outcomes


def main() -> None:
    lab.banner("D1.2  Coordinator-subagent orchestration (hub-and-spoke)")

    queries = [
        ("A - simple factual query", "When did the EU AI Act enter into force?"),
        ("B - broad research topic", "impact of AI on creative industries"),
    ]
    runs: dict[str, tuple[Coordinator, dict[str, Any]]] = {}
    for title, query in queries:
        lab.section(title)
        print(f"query: {query}")
        coordinator = Coordinator(lab.get_client(scripted_team))
        outcome = coordinator.research(query)
        runs[title] = (coordinator, outcome)
        print(f"route chosen by the coordinator: {outcome['route']}   refinement rounds: {outcome['rounds']}")
        for st in outcome["plan"]["subtopics"]:
            print(f"  slice {st['id']}: {st['focus']}")
        print("event log (every delegation and every result passed through the coordinator):")
        print_events(coordinator)
        print("answer:\n  " + outcome["answer"].replace("\n", "\n  "))

        lab.check(not isolation_violations(coordinator), "every subagent call was a fresh 1-message conversation with no coordinator history")
        lab.check(not unpaired_delegations(coordinator), "every delegation has exactly one logged result or error")
        if not lab.is_live() and title.startswith("A"):
            lab.check(outcome["route"] == ["web_search"] and len(coordinator.subagent_requests) == 1,
                      "simple factual query -> web_search only (1 subagent call, no synthesis or report)")
        if not lab.is_live() and title.startswith("B"):
            lab.check(outcome["route"] == list(ROLES), "broad topic -> full pipeline: search, analysis, synthesis, report")
            lab.check(outcome["rounds"] == 2, "synthesis reported a gap in round 1; the targeted follow-up closed it in round 2")
            lab.check("VFX Workforce Study" in outcome["answer"], "the report cites the document found only by the targeted follow-up")

    lab.section("What one subagent actually received")
    coordinator_b, _ = runs["B - broad research topic"]
    first = coordinator_b.subagent_requests[0]
    print(f"system: {first['system'].splitlines()[0]} ...")
    print(f"messages ({len(first['messages'])}):")
    print("  user: " + first["messages"][0]["content"].replace("\n", "\n        "))
    print(f"coordinator's own history at the end: {len(coordinator_b.history)} message(s), none of them sent to any subagent")

    if not lab.is_live():
        route_a, route_b = runs["A - simple factual query"][1]["route"], runs["B - broad research topic"][1]["route"]
        lab.check(route_a != route_b, "the coordinator picked different subagents for different queries")


if __name__ == "__main__":
    main()
