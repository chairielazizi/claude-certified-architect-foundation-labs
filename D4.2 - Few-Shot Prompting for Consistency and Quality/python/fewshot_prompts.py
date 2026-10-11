"""Zero-shot and few-shot prompt builders for D4.2.

Every example carries <reasoning> that says why this answer was chosen over the plausible
alternative. That is what lets the model generalize the *judgment* to code and documents
the examples never showed, instead of pattern-matching the examples literally.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def load_json(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# (a) Code review findings in a fixed format
# ---------------------------------------------------------------------------

# Detailed instructions. On their own they still produce drifting formats (the exam's point).
REVIEW_INSTRUCTIONS = (
    "You review one code snippet at a time. For each real issue give its location (file:line), "
    "the issue, a severity (low, medium, high or critical) and a suggested_fix. "
    "Respond with a JSON array of findings, or [] when there is nothing to fix."
)

REVIEW_EXAMPLES: list[dict[str, str]] = [
    {
        "name": "genuine issue: shows the exact output format and how severity is chosen",
        "file": "client/http.py",
        "code": "resp = requests.get(url)\nreturn resp.json()",
        "reasoning": (
            "requests.get has no timeout, so a stalled upstream hangs the worker forever. Rated medium, "
            "not high: it fails loudly under load instead of returning wrong data."
        ),
        "output": json.dumps(
            [
                {
                    "location": "client/http.py:1",
                    "issue": "No timeout on requests.get; a stalled upstream hangs the worker indefinitely.",
                    "severity": "medium",
                    "suggested_fix": "Pass timeout=(3, 10) and handle requests.Timeout.",
                }
            ]
        ),
    },
    {
        "name": "acceptable pattern that looks suspicious",
        "file": "api/views.py",
        "code": "try:\n    return render(order)\nexcept Exception:\n    log.exception('render failed')\n    raise",
        "reasoning": (
            "Not flagged. The except is broad, but it logs and re-raises, so nothing is swallowed and the "
            "framework still returns an error. Flagging every broad except would be a false positive."
        ),
        "output": "[]",
    },
    {
        "name": "genuine issue that resembles the acceptable one",
        "file": "importer/rows.py",
        "code": "for row in rows:\n    try:\n        save(parse(row))\n    except Exception:\n        continue",
        "reasoning": (
            "Flagged, although it looks like the previous example: here the error is discarded, so bad rows "
            "vanish and the import reports success. What matters is whether the failure stays visible or is "
            "intentionally handled, not whether the except is broad."
        ),
        "output": json.dumps(
            [
                {
                    "location": "importer/rows.py:4",
                    "issue": "Every exception is discarded; malformed rows disappear and the import still reports success.",
                    "severity": "high",
                    "suggested_fix": "Catch the parse error only, collect failed rows, and report them after the loop.",
                }
            ]
        ),
    },
]


def build_review_prompt(examples: list[dict[str, str]] | None = None) -> str:
    if not examples:
        return REVIEW_INSTRUCTIONS
    rendered = "\n".join(
        f'<example name="{e["name"]}">\n<code file="{e["file"]}">\n{e["code"]}\n</code>\n'
        f"<reasoning>{e['reasoning']}</reasoning>\n<output>{e['output']}</output>\n</example>"
        for e in examples
    )
    return f"{REVIEW_INSTRUCTIONS}\n\nFollow these examples exactly, including the output format.\n<examples>\n{rendered}\n</examples>"


def review_user_message(snippet: dict[str, Any]) -> str:
    return f'<code file="{snippet["file"]}">\n{snippet["code"]}\n</code>'


# ---------------------------------------------------------------------------
# (b) Extraction from documents with varied structures
# ---------------------------------------------------------------------------

EXTRACTION_INSTRUCTIONS = (
    "Extract from the research document: title; methodology (one sentence on how the study was done); "
    "citations (every work the document cites); measurements (quantities of materials used: quantity, "
    "unit, approximate, original_text). methodology, citations and measurements are required whenever "
    "the document contains them. Respond with one JSON object with exactly those four keys."
)

# One generic example. It fixes the format but shows none of the hard cases.
GENERIC_EXAMPLE: dict[str, str] = {
    "name": "standard paper",
    "document": (
        "Title: Leaf litter and beetle diversity\nMethods: We sampled 30 pitfall traps monthly for a year.\n"
        "Results: Diversity peaked in autumn (Moreno et al., 2018). Traps were baited with 50 mL of ethanol."
    ),
    "reasoning": "Methods heading gives the methodology; the parenthetical citation is the only reference.",
    "output": json.dumps(
        {
            "title": "Leaf litter and beetle diversity",
            "methodology": "Sampled 30 pitfall traps monthly for a year.",
            "citations": ["Moreno et al. (2018)"],
            "measurements": [{"quantity": 50, "unit": "mL", "approximate": False, "original_text": "50 mL of ethanol"}],
        }
    ),
}

# Targeted examples for the cases that came back null/empty in zero-shot runs.
TARGETED_EXAMPLES: list[dict[str, str]] = [
    {
        "name": "numbered citations with a bibliography at the end; no Methods heading",
        "document": (
            "Title: Commute length and sleep quality\nLong commutes predict shorter sleep [1]. We surveyed 310 "
            "office workers in two cities and compared self-reported commute times with wearable sleep data. "
            "The effect was strongest for commutes over an hour [2].\nReferences\n"
            "1. Okoro, A. (2019). Travel time and rest. Sleep Studies.\n"
            "2. Varga, P. (2021). Commuting and circadian health. Urban Health."
        ),
        "reasoning": (
            "There is no Methods heading, but 'We surveyed 310 office workers ... and compared ...' IS the "
            "methodology, so it is not null. The [1] and [2] markers point at the References list, so the "
            "citations are the bibliography entries, not the bracket numbers."
        ),
        "output": json.dumps(
            {
                "title": "Commute length and sleep quality",
                "methodology": "We surveyed 310 office workers in two cities and compared self-reported commute times with wearable sleep data.",
                "citations": [
                    "Okoro, A. (2019). Travel time and rest. Sleep Studies.",
                    "Varga, P. (2021). Commuting and circadian health. Urban Health.",
                ],
                "measurements": [],
            }
        ),
    },
    {
        "name": "informal measurements and a citation inside a sentence",
        "document": (
            "Title: Cold-brew extraction at home\nUsing the ratio from Tanaka's 2020 coffee guide, we steeped "
            "a handful of ground coffee in about two cups of cold water for 14 hours."
        ),
        "reasoning": (
            "'Tanaka's 2020 coffee guide' is a citation even without brackets. Informal amounts are still "
            "measurements: record the best numeric reading, keep the original words and mark them approximate "
            "rather than leaving them out. The 14 hours is a duration, not a material quantity."
        ),
        "output": json.dumps(
            {
                "title": "Cold-brew extraction at home",
                "methodology": "Using the ratio from Tanaka's 2020 coffee guide, we steeped a handful of ground coffee in about two cups of cold water for 14 hours.",
                "citations": ["Tanaka (2020)"],
                "measurements": [
                    {"quantity": 1, "unit": "handful", "approximate": True, "original_text": "a handful of ground coffee"},
                    {"quantity": 2, "unit": "cup", "approximate": True, "original_text": "about two cups of cold water"},
                ],
            }
        ),
    },
]


def build_extraction_prompt(examples: list[dict[str, str]] | None = None) -> str:
    if not examples:
        return EXTRACTION_INSTRUCTIONS
    rendered = "\n".join(
        f'<example name="{e["name"]}">\n<document>\n{e["document"]}\n</document>\n'
        f"<reasoning>{e['reasoning']}</reasoning>\n<output>{e['output']}</output>\n</example>"
        for e in examples
    )
    return f"{EXTRACTION_INSTRUCTIONS}\n\n<examples>\n{rendered}\n</examples>"


def extraction_user_message(doc: dict[str, Any]) -> str:
    return f"<document>\n{doc['text']}\n</document>"
