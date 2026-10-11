"""D1.2 - The iterative refinement loop and the single error-handling wrapper, under failure.

Both scenarios inject failures into the scripted subagents, so this file always runs offline.

  A  document_analysis times out once on the music slice. delegate() turns the exception
     into a structured error event and the run carries on; synthesis reports music as a
     coverage gap; the coordinator's targeted follow-up succeeds; coverage converges.
  B  every film source stays unavailable. Each round re-delegates and fails again. After
     MAX_REFINEMENT_ROUNDS the coordinator raises CoverageNotConverged instead of
     publishing a report with a silent hole.

Run:  python refinement_loop.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from coordinator import MAX_REFINEMENT_ROUNDS, Coordinator, CoverageNotConverged, print_events  # noqa: E402
from research_team import role_of, scripted_team, tag  # noqa: E402

TOPIC = "impact of AI on creative industries"


def failing_team(should_fail: Callable[[str, str], bool]) -> lab.Responder:
    """The scripted team, except that selected subagent calls raise like a timed-out request."""

    def respond(params: dict[str, Any]) -> lab.Obj:
        role = role_of(params)
        if should_fail(role, tag(lab.last_user_text(params), "slice").lower()):
            raise TimeoutError(f"{role} call timed out after 30s")
        return scripted_team(params)

    return respond


def interesting(event: dict[str, Any]) -> bool:
    """Events worth printing here: failures, refinement decisions, synthesis and follow-ups."""
    return event["event"] in ("error", "refine") or event["role"] == "synthesis" or event["task"].startswith("gap-")


def main() -> None:
    lab.banner("D1.2  Iterative refinement and error handling under failure (always offline)")

    lab.section("A - one subagent call times out; the loop recovers")
    failed_once: list[str] = []

    def music_docs_fail_once(role: str, focus: str) -> bool:
        if role == "document_analysis" and "music" in focus and not failed_once:
            failed_once.append(focus)
            return True
        return False

    coordinator = Coordinator(lab.ScriptedClient(failing_team(music_docs_fail_once)))
    outcome = coordinator.research(TOPIC)
    print("event log (failures, refinement and synthesis only):")
    print_events(coordinator, keep=interesting)
    errors = [e for e in coordinator.events if e["event"] == "error"]
    refines = [e for e in coordinator.events if e["event"] == "refine"]
    lab.check(len(errors) == 1 and errors[0]["detail"].startswith("timeout (retryable=True)"),
              "the exception became one structured error event (timeout, retryable); the run did not crash")
    lab.check("music: no document evidence" in refines[0]["detail"], "synthesis reported the failed slice as a coverage gap")
    lab.check(outcome["rounds"] == 2 and "Music Rights Review" in outcome["answer"],
              "the coordinator's targeted re-delegation filled the gap; coverage converged in round 2")

    lab.section("B - a source stays down; the loop is bounded")

    def film_always_fails(role: str, focus: str) -> bool:
        film_words = ("film", "video", "vfx", "visual effects")
        return role in ("web_search", "document_analysis") and any(w in focus for w in film_words)

    coordinator = Coordinator(lab.ScriptedClient(failing_team(film_always_fails)))
    raised: CoverageNotConverged | None = None
    try:
        coordinator.research(TOPIC)
    except CoverageNotConverged as exc:
        raised = exc
    print("event log (failures, refinement and synthesis only):")
    print_events(coordinator, keep=interesting)
    print(f"raised: {type(raised).__name__}: {raised}")

    errors = [e for e in coordinator.events if e["event"] == "error"]
    synth_calls = [e for e in coordinator.events if e["event"] == "delegate" and e["role"] == "synthesis"]
    lab.check(raised is not None, "the coordinator raised CoverageNotConverged instead of returning a partial report")
    lab.check(len(synth_calls) == MAX_REFINEMENT_ROUNDS, f"synthesis ran exactly MAX_REFINEMENT_ROUNDS={MAX_REFINEMENT_ROUNDS} times")
    lab.check(all(e["detail"].startswith("timeout (retryable=True)") for e in errors) and len(errors) > 1,
              f"all {len(errors)} failures went through the same wrapper and were logged the same way")
    lab.check(not any(e["role"] == "report" for e in coordinator.events), "no report was written")
    lab.check(raised is not None and {g["dimension"] for g in raised.gaps} == {"film"},
              "the exception names the dimension that never got covered")


if __name__ == "__main__":
    main()
