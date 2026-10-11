"""D5.5 - Aggregate accuracy can hide a weak segment.

97% overall looks ready for automation. Broken down by document type and field, one
segment (contract.effective_date) is right only about two times in three. It is 3% of the
volume, so it barely moves the average. Validate by segment before reducing human review.

Run:  python segment_accuracy.py      (pure computation; identical output in TypeScript)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_data import FIELDS, VALIDATION_COUNTS, VALIDATION_SEED, fingerprint, generate, pct, segments  # noqa: E402

BAR_PCT = 95  # accuracy a segment must reach before anyone talks about automating it


def main() -> None:
    lab.banner("D5.5  Aggregate accuracy vs accuracy by document type and field")
    items = generate(VALIDATION_SEED, VALIDATION_COUNTS)
    print(f"labelled validation set (mulberry32 seed {VALIDATION_SEED}): {fingerprint(items)}")

    lab.section("Aggregate")
    correct = sum(1 for x in items if x["correct"])
    print(f"  accuracy {pct(correct, len(items))} over {len(items)} extractions -> passes a {BAR_PCT}% bar")

    lab.section("By document type")
    by_type: dict[str, tuple[int, int]] = {}
    for doc_type in FIELDS:
        group = [x for x in items if x["doc_type"] == doc_type]
        ok = sum(1 for x in group if x["correct"])
        by_type[doc_type] = (ok, len(group))
        print(f"  {doc_type:10} {pct(ok, len(group)):>7}  ({ok}/{len(group)})")

    lab.section("By document type x field")
    print(f"  {'doc type':10}{'field':16}{'n':>5}{'accuracy':>10}")
    weak = []
    for segment, group in segments(items).items():
        doc_type, field = segment.split(".")
        ok = sum(1 for x in group if x["correct"])
        below = ok * 100 < BAR_PCT * len(group)
        if below:
            weak.append(segment)
        print(f"  {doc_type:10}{field:16}{len(group):>5}{pct(ok, len(group)):>10}" + ("   <-- below the bar" if below else ""))

    lab.section("Checks")
    weak_items = [x for x in items if x["segment"] in weak]
    weak_ok = sum(1 for x in weak_items if x["correct"])
    lab.check(correct * 1000 >= 970 * len(items), "the aggregate is about 97%: it looks ready for automation")
    lab.check(weak == ["contract.effective_date"], "exactly one segment is below the bar: contract.effective_date")
    lab.check(weak_ok * 100 < 75 * len(weak_items), "that segment is right only about 2 times in 3")
    lab.check(len(weak_items) * 100 <= 5 * len(items), "it is under 5% of the volume, which is why the aggregate hides it")
    (c_ok, c_n), (i_ok, i_n), (r_ok, r_n) = by_type["contract"], by_type["invoice"], by_type["receipt"]
    lab.check(c_ok * 100 < BAR_PCT * c_n and i_ok * 100 >= 97 * i_n and r_ok * 100 >= 97 * r_n, "by document type, contracts fail while invoices and receipts pass")


if __name__ == "__main__":
    main()
