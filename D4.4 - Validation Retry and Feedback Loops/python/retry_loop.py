"""D4.4 - Validation-retry with error feedback, and knowing when NOT to retry.

    extract -> validate (pydantic: formats, totals, conflict flag) -> issues?
        none                               -> accept (flag for review if conflict_detected)
        retryable (format/structure/math)  -> follow-up request = original document
                                              + the failed extraction + the specific errors
        not retryable (info not in source) -> do not retry: keep null + reason, route on

Run:  python retry_loop.py          (offline, scripted model)
      python retry_loop.py --live   (real Claude API)
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from invoice_validation import EXTRACT_TOOL, INVOICES, SYSTEM, Issue, feedback_text, is_retryable, validate  # noqa: E402
from scripted_extractor import scripted_extractor  # noqa: E402

MAX_RETRIES = 2


@dataclass
class Outcome:
    doc_id: str
    status: str  # accepted | needs_review | accepted_with_gaps | failed
    calls: int
    data: dict[str, Any] | None
    gaps: dict[str, str] = field(default_factory=dict)
    log: list[list[Issue]] = field(default_factory=list)


def extract_with_retry(client: Any, invoice: dict[str, Any], smart: bool = True) -> Outcome:
    document = invoice["text"]
    messages: list[dict[str, Any]] = [{"role": "user", "content": f"<document>\n{document}\n</document>"}]
    log: list[list[Issue]] = []
    for attempt in range(1, MAX_RETRIES + 2):
        response = client.messages.create(
            model=lab.MODEL, max_tokens=4000, system=SYSTEM, tools=[EXTRACT_TOOL], messages=messages
        )
        block = next((b for b in lab.tool_uses(response)), None)
        data = dict(block.input) if block else None
        inv, issues = validate(data)
        log.append(issues)
        if not issues:
            # Valid. A conflict in the SOURCE is not an extraction error: keep both totals, flag it.
            status = "needs_review" if inv and inv.conflict_detected else "accepted"
            return Outcome(invoice["id"], status, attempt, data, log=log)

        retryable = [i for i in issues if is_retryable(i, document)] if smart else issues
        if not retryable:
            gaps = {i.field: (data or {}).get(f"{i.field}_missing_reason") or i.message for i in issues}
            return Outcome(invoice["id"], "accepted_with_gaps", attempt, data, gaps, log)
        if attempt > MAX_RETRIES:
            break
        # Follow-up request: the original document stays as messages[0], the failed extraction is
        # the assistant tool_use, and the specific validation errors go back as an error result.
        messages.append({"role": "assistant", "content": response.content})
        if block:
            messages.append(
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": block.id, "content": feedback_text(retryable), "is_error": True}],
                }
            )
        else:
            messages.append({"role": "user", "content": feedback_text(retryable)})
    return Outcome(invoice["id"], "failed", MAX_RETRIES + 1, data, log=log)


def main() -> None:
    lab.banner("D4.4  Validation, retry with error feedback, retry limits")

    lab.section("1. Extract -> validate -> retry only what a retry can fix")
    outcomes: dict[str, Outcome] = {}
    clients: dict[str, Any] = {}
    for invoice in INVOICES:
        clients[invoice["id"]] = client = lab.get_client(scripted_extractor)
        outcome = outcomes[invoice["id"]] = extract_with_retry(client, invoice)
        print(f"  {invoice['id']} ({invoice['note']})")
        for n, issues in enumerate(outcome.log, 1):
            listed = "; ".join(f"{i.field} [{i.kind}{'' if is_retryable(i, invoice['text']) else ', NOT retryable'}]: {i.message}" for i in issues)
            print(f"     attempt {n}: {listed or 'valid'}")
        extra = ""
        if outcome.data and outcome.data.get("conflict_detected"):
            extra = f"  stated_total={outcome.data['stated_total']} calculated_total={outcome.data['calculated_total']}"
        if outcome.gaps:
            extra = f"  null + reason: {outcome.gaps}"
        print(f"     -> {outcome.status} after {outcome.calls} call(s){extra}")

    if not lab.is_live():
        lab.section("2. What the retry request for INV-A contained")
        retry_request = clients["INV-A"].messages.calls[1]["messages"]
        failed = retry_request[1]["content"][0]
        feedback = retry_request[2]["content"][0]
        print(f"  messages[0] user     : original document ({len(retry_request[0]['content'])} chars)")
        print(f"  messages[1] assistant: failed extraction -> invoice_date={failed.input['invoice_date']!r}, currency={failed.input['currency']!r}")
        print("  messages[2] user     : tool_result is_error=True ->\n      " + feedback["content"].replace("\n", "\n      "))

    lab.section("3. Naive loop (retry every error) vs smart loop")
    naive_calls = smart_calls = 0
    for invoice in INVOICES:
        naive = extract_with_retry(lab.get_client(scripted_extractor), invoice, smart=False)
        naive_calls += naive.calls
        smart_calls += outcomes[invoice["id"]].calls
        print(f"  {invoice['id']}: naive {naive.calls} call(s) -> {naive.status:<18} smart {outcomes[invoice['id']].calls} call(s) -> {outcomes[invoice['id']].status}")
    print(f"  wasted retries avoided: {naive_calls - smart_calls}")

    if not lab.is_live():
        a, b, c, d = (outcomes[k] for k in ("INV-A", "INV-B", "INV-C", "INV-D"))
        lab.check(a.status == "accepted" and a.calls == 2, "INV-A: format errors fixed on the retry")
        lab.check(
            "14/03/2026" in json.dumps(lab.to_plain(failed.input)) and "Kestrel Print Works" in retry_request[0]["content"]
            and "invoice_date: must be ISO 8601" in feedback["content"] and feedback["is_error"],
            "the retry request carried the original document, the failed extraction and the specific errors",
        )
        lab.check(
            b.calls == 1 and b.status == "accepted_with_gaps" and b.data is not None and b.data["po_number"] is None,
            "INV-B: PO number not in the source -> no retry, po_number left null",
        )
        lab.check("attached purchase order" in b.gaps.get("po_number", ""), "INV-B: the reason it is null travels with the record")
        lab.check(
            c.status == "needs_review" and c.calls == 1 and c.data is not None and c.data["calculated_total"] == 1150 and c.data["stated_total"] == 1200,
            "INV-C: stated vs calculated totals disagree in the SOURCE -> conflict_detected, routed to review, not retried",
        )
        lab.check(d.status == "accepted" and d.calls == 1, "INV-D: clean invoice accepted on the first call")
        lab.check(naive_calls - smart_calls == MAX_RETRIES, f"classifying errors avoided {MAX_RETRIES} pointless retries on INV-B")


if __name__ == "__main__":
    main()
