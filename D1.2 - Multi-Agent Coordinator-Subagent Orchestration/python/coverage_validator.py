"""Coverage checklist and the validator the coordinator runs on its OWN decomposition.

Sample question 7: every subagent did its job, yet the report missed music, writing and
film, because the coordinator only ever assigned visual-arts subtopics. Downstream agents
cannot notice what they were never asked to research, so the check belongs at the
coordinator, right after it decomposes the topic and before anything is delegated.

The checklist here is a small hand-written taxonomy. In production it could come from a
domain taxonomy, a client brief, or a separate "list the dimensions of this topic" call.
"""

from __future__ import annotations

import json
from typing import Any

# topic keyword -> {dimension: keywords that mean a subtopic covers it}
REQUIRED_DIMENSIONS: dict[str, dict[str, list[str]]] = {
    "creative industries": {
        "visual_arts": ["visual art", "digital art", "graphic design", "photography", "illustration"],
        "music": ["music"],
        "writing": ["writing", "publishing", "literature", "journalism"],
        "film": ["film", "video", "cinema", "animation", "visual effects", "vfx"],
    },
}


def checklist_for(topic: str) -> dict[str, list[str]]:
    lowered = topic.lower()
    return next((dims for key, dims in REQUIRED_DIMENSIONS.items() if key in lowered), {})


def dimensions_of(focus: str, checklist: dict[str, list[str]]) -> list[str]:
    lowered = focus.lower()
    return [dim for dim, keywords in checklist.items() if any(k in lowered for k in keywords)]


def validate_coverage(topic: str, subtopics: list[dict[str, str]]) -> dict[str, Any]:
    """Check a decomposition against the topic's required dimensions.

    missing  - required dimensions no subtopic covers (incomplete research)
    overlaps - dimensions claimed by several subtopics (agents will return the same sources)
    """
    checklist = checklist_for(topic)
    slice_dims = {st["id"]: dimensions_of(st["focus"], checklist) for st in subtopics}
    covered = {dim: [sid for sid, dims in slice_dims.items() if dim in dims] for dim in checklist}
    missing = [dim for dim, ids in covered.items() if not ids]
    overlaps = {dim: ids for dim, ids in covered.items() if len(ids) > 1}
    return {
        "has_checklist": bool(checklist),
        "required": list(checklist),
        "slice_dimensions": slice_dims,
        "missing": missing,
        "overlaps": overlaps,
        "ok": not missing and not overlaps,
    }


def feedback_for(report: dict[str, Any]) -> str:
    """Validator result as a message back to the coordinator (machine-readable parts in tags)."""
    return (
        "Your decomposition failed the coverage check.\n"
        f"<missing>{json.dumps(report['missing'])}</missing>\n"
        f"<overlaps>{json.dumps(report['overlaps'])}</overlaps>\n"
        "Revise the subtopics: give every missing dimension its own subtopic and merge overlapping ones."
    )
