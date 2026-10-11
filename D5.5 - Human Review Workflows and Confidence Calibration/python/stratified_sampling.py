"""D5.5 - Stratified random sampling of auto-accepted extractions.

Auto-accepted extractions still need ongoing measurement: the validation set cannot
contain failure modes that only appear later. Here the production batch includes a new
contract template (layout "scanned_v2") whose governing_law field is misread with HIGH
confidence, so it sails through the calibrated threshold.

Two audit designs with the same budget of 150 human checks:
    uniform     150 drawn from the whole auto-accepted pool (contracts are ~4% of it)
    stratified  50 drawn from each document type

Reviewers label the sample (the lab knows the truth). Error clusters by (segment, layout)
with at least 3 sampled errors raise a novel-pattern alert.

Run:  python stratified_sampling.py      (pure computation; identical output in TypeScript)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_data import (  # noqa: E402
    FIELDS,
    PATTERN_MIN_ERRORS,
    PER_STRATUM,
    PRODUCTION_COUNTS,
    PRODUCTION_SEED,
    SAMPLE_SEED,
    VALIDATION_COUNTS,
    VALIDATION_SEED,
    Mulberry32,
    calibrate_all,
    generate,
    pct,
    route,
    sample_without_replacement,
)

ERROR_BAR_PCT = 1  # what calibration promised: at most 1% errors among auto-accepted items


def audit(name: str, sample: list[dict[str, Any]], auto: list[dict[str, Any]]) -> dict[str, Any]:
    lab.section(f"{name} sample ({len(sample)} checks)")
    print(f"  {'stratum':10}{'auto pool':>10}{'sampled':>9}{'errors':>8}{'error rate':>12}")
    flagged = []
    for doc_type in FIELDS:
        pool = sum(1 for x in auto if x["doc_type"] == doc_type)
        drawn = [x for x in sample if x["doc_type"] == doc_type]
        errors = sum(1 for x in drawn if not x["correct"])
        over = errors * 100 > ERROR_BAR_PCT * len(drawn)
        if over and len(drawn) >= 30:
            flagged.append(doc_type)
        note = "   <-- above the 1% bar" if over and len(drawn) >= 30 else ("   (too few to measure)" if len(drawn) < 30 else "")
        print(f"  {doc_type:10}{pool:>10}{len(drawn):>9}{errors:>8}{pct(errors, len(drawn)):>12}{note}")
    clusters: dict[str, int] = {}
    for x in sample:
        if not x["correct"]:
            key = f"{x['segment']} on layout {x['layout']}"
            clusters[key] = clusters.get(key, 0) + 1
    alerts = [k for k, n in clusters.items() if n >= PATTERN_MIN_ERRORS]
    for key in alerts:
        print(f"  ALERT novel error pattern: {key} ({clusters[key]} sampled errors) -> pause auto-accept, re-validate")
    if not alerts:
        print("  no error cluster large enough to raise an alert")
    return {"sample": sample, "flagged": flagged, "alerts": alerts}


def main() -> None:
    lab.banner("D5.5  Stratified sampling of high-confidence extractions")
    validation = generate(VALIDATION_SEED, VALIDATION_COUNTS)
    thresholds = calibrate_all(validation)
    auto, _ = route(generate(PRODUCTION_SEED, PRODUCTION_COUNTS, production=True), thresholds)
    print(f"auto-accepted production extractions: {len(auto)}; audit budget {3 * PER_STRATUM} checks (sampling seed {SAMPLE_SEED})")

    rng = Mulberry32(SAMPLE_SEED)
    uniform = audit("Uniform", sample_without_replacement(auto, 3 * PER_STRATUM, rng), auto)
    rng = Mulberry32(SAMPLE_SEED)
    stratified_sample: list[dict[str, Any]] = []
    for doc_type in FIELDS:
        stratified_sample += sample_without_replacement([x for x in auto if x["doc_type"] == doc_type], PER_STRATUM, rng)
    stratified = audit("Stratified", stratified_sample, auto)

    lab.section("Checks")
    contracts_uniform = sum(1 for x in uniform["sample"] if x["doc_type"] == "contract")
    lab.check(contracts_uniform < 15, f"uniform sampling gave the small contract stratum only {contracts_uniform} checks")
    lab.check(
        all(sum(1 for x in stratified["sample"] if x["doc_type"] == t) == PER_STRATUM for t in FIELDS),
        f"stratified sampling measured every document type with {PER_STRATUM} checks",
    )
    target = "contract.governing_law on layout scanned_v2"
    lab.check(stratified["alerts"] == [target] and not uniform["alerts"], "only the stratified audit caught the novel error pattern")
    lab.check(stratified["flagged"] == ["contract"], "stratified error rates single out the contract stratum as above the 1% bar")
    lab.check(all(x["layout"] == "standard" for x in validation), "the failing layout never appeared in the validation set: calibration could not have caught it")


if __name__ == "__main__":
    main()
