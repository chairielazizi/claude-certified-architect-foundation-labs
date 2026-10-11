"""D5.5 - Route a production batch: auto-accept, or queue for humans by risk x uncertainty.

Thresholds come from the labelled validation set. In the production batch an extraction
goes to the human queue when:
    * its source document is contradictory (e.g. two different totals),
    * its segment failed the automation gate (contract.effective_date), or
    * its confidence is below the segment's calibrated threshold.
Reviewer capacity is limited, so the queue is ordered by risk (cost of the field being
wrong) x uncertainty (100 - confidence; 100 for contradictory sources). What does not
fit today waits: it is never auto-accepted just because the queue is full.

Run:  python review_routing.py      (pure computation; identical output in TypeScript)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_data import (  # noqa: E402
    PRODUCTION_COUNTS,
    PRODUCTION_SEED,
    REVIEW_CAPACITY,
    VALIDATION_COUNTS,
    VALIDATION_SEED,
    calibrate_all,
    fingerprint,
    generate,
    pct,
    route,
)

REASONS = ["contradictory source", "segment below the accuracy bar", "low confidence"]


def main() -> None:
    lab.banner("D5.5  Review routing within limited reviewer capacity")
    thresholds = calibrate_all(generate(VALIDATION_SEED, VALIDATION_COUNTS))
    batch = generate(PRODUCTION_SEED, PRODUCTION_COUNTS, production=True)
    print(f"production batch (seed {PRODUCTION_SEED}): {fingerprint(batch)}")
    auto, queue = route(batch, thresholds)
    today, backlog = queue[:REVIEW_CAPACITY], queue[REVIEW_CAPACITY:]

    lab.section("Routing")
    print(f"  auto-accepted     {len(auto):>5}  ({pct(len(auto), len(batch))} of extractions)")
    print(f"  human queue       {len(queue):>5}")
    for reason in REASONS:
        print(f"    {reason:32}{sum(1 for q in queue if q['reason'] == reason):>5}")
    print(f"  reviewed today    {len(today):>5}  (capacity {REVIEW_CAPACITY}); waiting {len(backlog)}")

    lab.section("Top of the queue (priority = risk x uncertainty)")
    print(f"  {'priority':>8}  {'doc':12}{'field':16}{'conf':>5}  reason")
    for q in queue[:8]:
        print(f"  {q['priority']:>8}  {q['doc_id']:12}{q['field']:16}{q['confidence']:>5}  {q['reason']}")
    print(f"  ... last item reviewed today has priority {today[-1]['priority']}; first waiting item {backlog[0]['priority']}")

    lab.section("Checks")
    auto_ids = {(x["doc_id"], x["field"]) for x in auto}
    lab.check(not any(x["contradictory"] for x in auto), "no field from a contradictory document was auto-accepted")
    lab.check(not any(x["segment"] == "contract.effective_date" for x in auto), "nothing from the gated segment was auto-accepted")
    lab.check(all(a["priority"] >= b["priority"] for a, b in zip(queue, queue[1:])), "the queue is ordered by risk x uncertainty")
    top = queue[0]["priority"]
    lab.check(
        all(q in today for q in queue if q["priority"] == top) and top == 5 * 100,
        "every top-priority item (risk-5 field in a contradictory document) is reviewed in today's batch",
    )
    lab.check(
        len(today) == REVIEW_CAPACITY and not ({(q["doc_id"], q["field"]) for q in backlog} & auto_ids),
        "capacity is respected and the overflow waits instead of being auto-accepted",
    )


if __name__ == "__main__":
    main()
