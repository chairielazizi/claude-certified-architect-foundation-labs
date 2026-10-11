"""Synthetic labelled extractions and calibration helpers shared by the D5.5 demos.

Everything is pure computation on a seeded PRNG (mulberry32), implemented bit-for-bit the
same way in reviewData.ts, so the Python and TypeScript demos print identical numbers.
All arithmetic that reaches the output is integer arithmetic (confidence is an integer
0-99, percentages are rounded half-up in integer math) to avoid float formatting drift.

Each extraction is one field of one document:
    {doc_id, doc_type, field, segment, confidence, correct, layout, contradictory}
"""

from __future__ import annotations

import math
from typing import Any

MASK = 0xFFFFFFFF


class Mulberry32:
    """Small seeded PRNG. Unsigned 32-bit version of the classic JS one-liner (see reviewData.ts)."""

    def __init__(self, seed: int) -> None:
        self.state = seed & MASK

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & MASK
        t = self.state
        t = ((t ^ (t >> 15)) * (t | 1)) & MASK
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & MASK)) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296


VALIDATION_SEED = 2026
PRODUCTION_SEED = 7
VALIDATION_COUNTS = {"invoice": 400, "receipt": 400, "contract": 100}
PRODUCTION_COUNTS = {"invoice": 600, "receipt": 300, "contract": 60}
TYPE_CODE = {"invoice": "INV", "receipt": "RCT", "contract": "CTR"}

# (field, true accuracy in per-mille). contract.effective_date is the weak segment.
FIELDS: dict[str, list[tuple[str, int]]] = {
    "invoice": [("vendor_name", 990), ("invoice_number", 985), ("invoice_date", 980), ("total_amount", 985)],
    "receipt": [("merchant_name", 975), ("purchase_date", 980), ("total_amount", 985)],
    "contract": [("party_names", 960), ("effective_date", 640), ("governing_law", 975), ("renewal_term", 950)],
}
# Errors in this segment come with confidence as high as correct answers (ambiguous dates).
CONFIDENTLY_WRONG = {"contract.effective_date"}
# Cost of an undetected error, per field (used to prioritise reviewer time).
RISK = {
    "total_amount": 5, "effective_date": 5, "party_names": 4, "renewal_term": 4, "invoice_number": 3,
    "governing_law": 3, "invoice_date": 2, "purchase_date": 2, "vendor_name": 2, "merchant_name": 1,
}

TARGET_PRECISION_PCT = 99  # auto-accepted extractions must be at least this precise
MIN_SUPPORT = 30  # a threshold needs this many validation items above it to be trusted
MIN_THRESHOLD = 50  # never auto-accept below this confidence, whatever the validation set says


def generate(seed: int, counts: dict[str, int], production: bool = False) -> list[dict[str, Any]]:
    """Deterministic extractions. Production batches add a new contract layout and contradictory documents."""
    rng = Mulberry32(seed)
    prefix = "P-" if production else "V-"
    out: list[dict[str, Any]] = []
    for doc_type, n in counts.items():
        for i in range(1, n + 1):
            layout, contradictory = "standard", False
            if production:
                if doc_type == "contract" and rng.next() < 0.35:
                    layout = "scanned_v2"  # a contract template the validation set never saw
                contradictory = rng.next() < 0.02  # e.g. two different totals in one document
            for field, accuracy in FIELDS[doc_type]:
                segment = f"{doc_type}.{field}"
                novel = production and layout == "scanned_v2" and field == "governing_law"
                correct = rng.next() * 1000 < (400 if novel else accuracy)
                if correct:
                    confidence = 60 + math.floor(max(rng.next(), rng.next()) * 40)
                elif novel:
                    confidence = 85 + math.floor(rng.next() * 15)  # new failure mode, confidently wrong
                elif segment in CONFIDENTLY_WRONG:
                    confidence = 60 + math.floor(rng.next() * 40)
                else:
                    confidence = 35 + math.floor(rng.next() * 50)
                out.append({
                    "doc_id": f"{prefix}{TYPE_CODE[doc_type]}-{i:04d}", "doc_type": doc_type, "field": field,
                    "segment": segment, "confidence": confidence, "correct": correct,
                    "layout": layout, "contradictory": contradictory,
                })
    return out


def pct(n: int, d: int) -> str:
    """n/d as a percentage with one decimal, rounded half-up in integer math (identical in TS)."""
    if d == 0:
        return "-"
    tenths = (n * 2000 + d) // (2 * d)
    return f"{tenths // 10}.{tenths % 10}%"


def fingerprint(items: list[dict[str, Any]]) -> str:
    """A checksum to confirm the Python and TypeScript generators agree."""
    total = 0
    for i, x in enumerate(items, 1):
        total = (total * 31 + i * (x["confidence"] + 1) * (2 if x["correct"] else 1)) % 1_000_000_007
    return f"{len(items)} extractions, {sum(1 for x in items if x['correct'])} correct, checksum {total}"


def segments(items: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for x in items:
        out.setdefault(x["segment"], []).append(x)
    return out


def calibrate(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Lowest confidence threshold whose auto-accepted set meets the precision target."""
    for threshold in range(MIN_THRESHOLD, 100):
        above = [x for x in items if x["confidence"] >= threshold]
        if len(above) < MIN_SUPPORT:
            return None  # higher thresholds only have fewer items
        correct = sum(1 for x in above if x["correct"])
        if correct * 100 >= TARGET_PRECISION_PCT * len(above):
            return {"threshold": threshold, "correct": correct, "accepted": len(above), "total": len(items)}
    return None


def calibrate_all(items: list[dict[str, Any]]) -> dict[str, dict[str, Any] | None]:
    return {segment: calibrate(group) for segment, group in segments(items).items()}


def precision_at(items: list[dict[str, Any]], threshold: int) -> tuple[int, int]:
    above = [x for x in items if x["confidence"] >= threshold]
    return sum(1 for x in above if x["correct"]), len(above)


REVIEW_CAPACITY = 120  # extractions the review team can check per batch
SAMPLE_SEED = 99
PER_STRATUM = 50  # stratified audit sample per document type
PATTERN_MIN_ERRORS = 3  # sampled errors in one (segment, layout) cluster that trigger an alert


def route(items: list[dict[str, Any]], thresholds: dict[str, dict[str, Any] | None]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split into auto-accepted and a human queue ordered by risk x uncertainty."""
    auto: list[dict[str, Any]] = []
    queue: list[dict[str, Any]] = []
    for x in items:
        calibrated = thresholds[x["segment"]]
        if x["contradictory"]:
            reason = "contradictory source"
        elif calibrated is None:
            reason = "segment below the accuracy bar"
        elif x["confidence"] < calibrated["threshold"]:
            reason = "low confidence"
        else:
            auto.append(x)
            continue
        # A contradictory source makes the model's confidence meaningless: treat it as fully uncertain.
        uncertainty = 100 if x["contradictory"] else 100 - x["confidence"]
        queue.append({**x, "reason": reason, "priority": RISK[x["field"]] * uncertainty})
    queue.sort(key=lambda q: (-q["priority"], q["doc_id"], q["field"]))
    return auto, queue


def sample_without_replacement(items: list[Any], k: int, rng: Mulberry32) -> list[Any]:
    """Partial Fisher-Yates shuffle driven by the shared PRNG."""
    pool = list(items)
    k = min(k, len(pool))
    for i in range(k):
        j = i + math.floor(rng.next() * (len(pool) - i))
        pool[i], pool[j] = pool[j], pool[i]
    return pool[:k]
