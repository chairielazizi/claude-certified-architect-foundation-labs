"""D1.2 - Scope partitioning and the coverage validator (sample question 7).

Q7: on "impact of AI on creative industries" every subagent succeeded, yet the final
report covered only visual arts. The coordinator's log shows why: it decomposed the topic
into "AI in digital art creation", "AI in graphic design" and "AI in photography". The
root cause is the coordinator's decomposition, not the agents downstream of it.

  1. run the validator on that exact decomposition -> missing music, writing, film
  2. put the validator inside the coordinator's planning loop -> the re-plan covers them
  3. show the resulting partition: distinct slices x distinct source types, no overlap

Run:  python scope_partitioning.py          (offline)
      python scope_partitioning.py --live   (step 2 uses the real model as the coordinator)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from coordinator import SOURCE_TYPES, Coordinator, print_events  # noqa: E402
from coverage_validator import checklist_for, dimensions_of, validate_coverage  # noqa: E402
from research_team import COORDINATOR_PROMPT, CREATIVE_SUBTOPICS, ROLES, scripted_team, tag  # noqa: E402

Q7_TOPIC = "impact of AI on creative industries"
Q7_DECOMPOSITION = [
    {"id": "st1", "focus": "AI in digital art creation"},
    {"id": "st2", "focus": "AI in graphic design"},
    {"id": "st3", "focus": "AI in photography"},
]
# One well-scoped slice per dimension (what the repaired plan uses).
SLICE_FOR = {dimensions_of(st["focus"], checklist_for(Q7_TOPIC))[0]: st["focus"] for st in CREATIVE_SUBTOPICS}


def q7_coordinator(params: dict[str, Any]) -> lab.Obj:
    """Plays the sample-question-7 coordinator; every other role is the normal scripted team.

    Its first decomposition covers visual arts only. Given the validator's feedback it
    repairs the plan: merges the overlapping slices and adds one slice per missing dimension.
    """
    if lab.system_text(params) != COORDINATOR_PROMPT:
        return scripted_team(params)
    if len(params["messages"]) == 1:
        subtopics = Q7_DECOMPOSITION
    else:
        feedback = lab.last_user_text(params)
        missing = json.loads(tag(feedback, "missing") or "[]")
        overlaps = json.loads(tag(feedback, "overlaps") or "{}")
        previous = json.loads(lab.text_of(lab.Obj(content=params["messages"][-2]["content"])))["subtopics"]
        merged = {sid for ids in overlaps.values() for sid in ids}
        kept = [st["focus"] for st in previous if st["id"] not in merged]
        focuses = kept + [SLICE_FOR[d] for d in overlaps] + [SLICE_FOR[d] for d in missing]
        subtopics = [{"id": f"st{i}", "focus": f} for i, f in enumerate(focuses, 1)]
    plan = {
        "complexity": "broad",
        "rationale": "Broad topic: one slice per creative sector.",
        "subagents": list(ROLES),
        "subtopics": subtopics,
    }
    return lab.message(lab.text(json.dumps(plan)))


def main() -> None:
    lab.banner("D1.2  Scope partitioning and coverage validation (sample question 7)")

    lab.section("1. The coordinator's decomposition from sample question 7")
    for st in Q7_DECOMPOSITION:
        print(f"  {st['id']}: {st['focus']}")
    report = validate_coverage(Q7_TOPIC, Q7_DECOMPOSITION)
    print(f"validator: required={report['required']}")
    print(f"           slice -> dimension {report['slice_dimensions']}")
    print(f"           missing={report['missing']}  overlaps={report['overlaps']}  ok={report['ok']}")
    print("Each subagent would complete these assignments correctly. The gap is in WHAT was assigned.")
    lab.check(report["missing"] == ["music", "writing", "film"], "validator flags exactly what the Q7 report missed: music, writing, film")
    lab.check(report["overlaps"] == {"visual_arts": ["st1", "st2", "st3"]}, "all three slices crowd into visual arts, so their sources would overlap")

    lab.section("2. The validator inside the coordinator's planning loop")
    coordinator = Coordinator(lab.get_client(q7_coordinator))
    plan = coordinator.plan(Q7_TOPIC)
    print_events(coordinator)
    print("accepted plan:")
    for st in plan["subtopics"]:
        print(f"  {st['id']}: {st['focus']}   -> {plan['coverage']['slice_dimensions'][st['id']]}")
    lab.check(plan["coverage"]["ok"], "the accepted plan covers every required dimension with no overlap")
    lab.check(not coordinator.subagent_requests, "the decomposition is checked before anything is delegated (0 subagent calls)")
    if not lab.is_live():
        lab.check(len(coordinator.plans) == 2, "plan 1 (visual arts only) was rejected; the re-plan built from the feedback passed")

    lab.section("3. The partition: distinct slices x distinct source types")
    assignments = []
    print(f"  {'slice':<5} {'dimension':<12} {'web_search':<24} document_analysis")
    for st in plan["subtopics"]:
        dimension = plan["coverage"]["slice_dimensions"][st["id"]][0]
        assignments += [(dimension, SOURCE_TYPES[role][0]) for role in ("web_search", "document_analysis")]
        print(f"  {st['id']:<5} {dimension:<12} {'news + web articles':<24} reports + papers")
    lab.check(len(set(assignments)) == len(assignments), "no two assignments share a (dimension, source type), so no duplicated research")


if __name__ == "__main__":
    main()
