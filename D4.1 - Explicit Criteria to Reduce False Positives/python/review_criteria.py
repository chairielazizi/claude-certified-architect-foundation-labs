"""Review prompts for D4.1: vague instructions vs explicit categorical criteria.

The explicit prompt is *generated* from data (categories, toggles, severity rubric) so a
team can switch a noisy category off for a while without hand-editing prose, and so the
prompt and the precision report always agree on what each category means.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

SEVERITIES = ["critical", "high", "medium", "low"]

# Each category says exactly WHAT qualifies. "report" categories can be toggled off;
# "skip" categories are permanent exclusions (style, patterns the codebase already uses).
CATEGORIES: dict[str, dict[str, str]] = {
    "bug": {
        "action": "report",
        "criterion": "Code that produces a wrong result, a crash or data loss on a realistic input. Name the input.",
    },
    "security": {
        "action": "report",
        "criterion": "Injection, auth bypass, secret exposure or unsafe deserialization reachable from untrusted input.",
    },
    "performance": {
        "action": "report",
        "criterion": "Only when the complexity class changes on realistic data (N+1 queries, quadratic loops over unbounded input).",
    },
    "comment_accuracy": {
        "action": "report",
        # The exam's example of an explicit criterion: contradiction, not "accuracy".
        "criterion": (
            "Flag a comment ONLY when the behavior it claims contradicts what the code actually does "
            "(e.g. it says 'returns None' but the code raises). Do not flag comments that are terse, "
            "incomplete or imprecise."
        ),
    },
    "style": {
        "action": "skip",
        "criterion": "Naming, formatting, missing type hints or docstrings, line length.",
    },
    "local_pattern": {
        "action": "skip",
        "criterion": "Code that follows a pattern already used consistently in this codebase, even if you would design it differently.",
    },
}

# Severity levels defined by a concrete code example each, so two reviewers (or two runs)
# put the same issue in the same bucket.
SEVERITY_RUBRIC: list[dict[str, str]] = [
    {
        "level": "critical",
        "definition": "Exploitable security flaw or silent data loss.",
        "example": "query = f\"SELECT * FROM users WHERE id = '{user_id}'\"",
    },
    {
        "level": "high",
        "definition": "Wrong result on a normal, common path.",
        "example": "pages = rows // PAGE_SIZE   # last partial page is never shown",
    },
    {
        "level": "medium",
        "definition": "Wrong only in an edge case, or a comment that contradicts the code so callers will misuse it.",
        "example": "# returns None if missing\nreturn cache[key]   # actually raises KeyError",
    },
    {
        "level": "low",
        "definition": "Real but minor; no wrong result.",
        "example": "data = open(path).read()   # handle never closed in a long-running worker",
    },
]

# Toggles cover the "report" categories. Flip one to False to stop reporting it while its
# criterion is being rewritten; it moves to the SKIP list with a note.
DEFAULT_TOGGLES: dict[str, bool] = {name: True for name, c in CATEGORIES.items() if c["action"] == "report"}

OUTPUT_INSTRUCTIONS = (
    'Respond with JSON only: {"findings": [{"line": <int>, "category": <category>, '
    '"severity": "critical|high|medium|low", "issue": <one sentence>}]}. '
    'Return {"findings": []} when nothing qualifies.'
)

# Same shape as JSON schema, for output_config.format in live mode (guarantees parseable JSON
# so the comparison is about WHICH findings come back, not about formatting).
FINDINGS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer"},
                    "category": {"type": "string", "enum": list(CATEGORIES)},
                    "severity": {"type": "string", "enum": SEVERITIES},
                    "issue": {"type": "string"},
                },
                "required": ["line", "category", "severity", "issue"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["findings"],
    "additionalProperties": False,
}


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    line: int
    category: Literal["bug", "security", "performance", "comment_accuracy", "style", "local_pattern"]
    severity: Literal["critical", "high", "medium", "low"]
    issue: str


class ReviewOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    findings: list[Finding]


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------


def build_vague_prompt() -> str:
    """What teams usually start with: sounds reasonable, defines nothing."""
    return (
        "You are reviewing a pull request diff. Look for bugs, security problems and anything else "
        "worth improving. Check that comments are accurate. Assign each finding a severity.\n\n"
        + OUTPUT_INSTRUCTIONS
    )


def build_conservative_prompt() -> str:
    """The usual 'fix' for noise: ask for caution. It does not say WHAT to skip."""
    return (
        build_vague_prompt().replace(OUTPUT_INSTRUCTIONS, "")
        + "Be conservative. Only report high-confidence findings.\n\n"
        + OUTPUT_INSTRUCTIONS
    )


def build_explicit_prompt(toggles: dict[str, bool] | None = None) -> str:
    """Categorical REPORT/SKIP criteria + severity rubric with a code example per level."""
    toggles = {**DEFAULT_TOGGLES, **(toggles or {})}
    report = [n for n, c in CATEGORIES.items() if c["action"] == "report" and toggles.get(n, True)]
    disabled = [n for n, c in CATEGORIES.items() if c["action"] == "report" and not toggles.get(n, True)]
    skip = [n for n, c in CATEGORIES.items() if c["action"] == "skip"]

    lines = [
        "You are reviewing a pull request diff. Report only issues that meet the criteria below.",
        "",
        "REPORT only these categories:",
        *[f"- {n}: {CATEGORIES[n]['criterion']}" for n in report],
        "",
        "SKIP (do not report these, even when you are confident):",
        *[f"- {n}: {CATEGORIES[n]['criterion']}" for n in skip],
        *[f"- {n}: temporarily disabled while its criteria are being improved." for n in disabled],
        "",
        "SEVERITY RUBRIC (pick the level whose example is closest):",
    ]
    for level in SEVERITY_RUBRIC:
        example = level["example"].replace("\n", "\n      ")
        lines.append(f"- {level['level']}: {level['definition']}\n    e.g. {example}")
    lines += ["", OUTPUT_INSTRUCTIONS]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Precision metrics
# ---------------------------------------------------------------------------


def precision_by_category(findings: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """{category: {reported, true_positives, precision}} from labelled findings."""
    stats: dict[str, dict[str, Any]] = {}
    for f in findings:
        s = stats.setdefault(f["category"], {"reported": 0, "true_positives": 0})
        s["reported"] += 1
        s["true_positives"] += f["label"] == "true_positive"
    for s in stats.values():
        s["precision"] = s["true_positives"] / s["reported"]
    return stats


def overall_precision(findings: list[dict[str, Any]], include: set[str] | None = None) -> float:
    kept = [f for f in findings if include is None or f["category"] in include]
    return sum(f["label"] == "true_positive" for f in kept) / len(kept) if kept else 1.0


def categories_to_disable(stats: dict[str, dict[str, Any]], min_precision: float = 0.6, min_samples: int = 5) -> list[str]:
    """Categories with enough data AND precision below the bar. Small samples are left alone."""
    return sorted(n for n, s in stats.items() if s["reported"] >= min_samples and s["precision"] < min_precision)


def load_json(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))
