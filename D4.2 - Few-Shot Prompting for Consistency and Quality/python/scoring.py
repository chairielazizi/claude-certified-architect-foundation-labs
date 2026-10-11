"""Scorers for D4.2: is the output in the required format, and are required fields filled?"""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError


class ReviewFinding(BaseModel):
    # extra="forbid": a finding with "line"/"problem"/"level" keys is a format failure, not a pass.
    model_config = ConfigDict(extra="forbid")
    location: str
    issue: str
    severity: Literal["low", "medium", "high", "critical"]
    suggested_fix: str


class Measurement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quantity: float | None
    unit: str
    approximate: bool
    original_text: str


class PaperExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    methodology: str | None
    citations: list[str]
    measurements: list[Measurement]


def conforms(output_text: str) -> tuple[bool, str]:
    """(ok, reason): output must be a JSON array whose items all match ReviewFinding exactly."""
    try:
        data = json.loads(output_text)
    except json.JSONDecodeError:
        return False, "not JSON"
    if not isinstance(data, list):
        return False, f"JSON {type(data).__name__}, not an array"
    try:
        for item in data:
            ReviewFinding.model_validate(item)
    except ValidationError as exc:
        first = exc.errors()[0]
        return False, f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}"
    return True, "ok"


def format_consistency(outputs: list[str]) -> float:
    return sum(conforms(o)[0] for o in outputs) / len(outputs)


def finding_count(output_text: str) -> int:
    """Lenient count used for FP/recall scoring, so prose answers are still judged on substance."""
    text = output_text.strip()
    try:
        data = json.loads(text)
        return len(data) if isinstance(data, list) else 1
    except json.JSONDecodeError:
        return 0 if (not text or "no issues" in text.lower()) else 1


def parse_extraction(output_text: str) -> PaperExtraction | None:
    """Lenient parse (live replies may wrap JSON in prose or fences); None if unusable."""
    start, end = output_text.find("{"), output_text.rfind("}")
    try:
        return PaperExtraction.model_validate(json.loads(output_text[start : end + 1]))
    except (json.JSONDecodeError, ValidationError):
        return None


def missing_required(extraction: PaperExtraction | None, expected: dict[str, Any]) -> list[str]:
    """Required fields that came back null/empty although the document contains them."""
    if extraction is None:
        return [k for k in ("methodology", "citations", "measurements") if expected[k]]
    missing = []
    if expected["methodology"] and not extraction.methodology:
        missing.append("methodology")
    if expected["citations"] and not extraction.citations:
        missing.append("citations")
    if expected["measurements"] and not extraction.measurements:
        missing.append("measurements")
    return missing
