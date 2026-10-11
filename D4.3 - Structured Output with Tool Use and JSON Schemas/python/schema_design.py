"""D4.3 - Schema design decides what the model is ALLOWED to say.

    required non-null field, absent from the document -> the model invents a value
    nullable field                                      -> null, nothing fabricated
    enum without "other"                                -> forced into a wrong bucket
    enum + "other" + category_detail                    -> extensible, nothing lost
    enum + "unclear"                                    -> ambiguity admitted, not guessed
    format rules in the prompt                          -> ISO dates, ISO 4217 currency

Every extraction is read from the tool_use block's .input and parsed into a pydantic model.

Run:  python schema_design.py          (offline, scripted model)
      python schema_design.py --live   (real Claude API; forced tool_choice uses FORCED_TOOL_CHOICE_MODEL)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from extraction_tools import SYSTEM_BASE, SYSTEM_WITH_RULES, Invoice, doc, document_message, first_tool_use, invoice_tool  # noqa: E402
from scripted_extractor import scripted_extractor  # noqa: E402

CLIENT = lab.get_client(scripted_extractor)


def extract(doc_id: str, tool: dict[str, Any], system: str = SYSTEM_WITH_RULES) -> Invoice:
    response = CLIENT.messages.create(
        model=lab.FORCED_TOOL_CHOICE_MODEL,  # forced tool_choice is a 400 on claude-opus-5-5
        max_tokens=4000,
        system=system,
        tools=[tool],
        tool_choice={"type": "tool", "name": "extract_invoice"},
        messages=[{"role": "user", "content": document_message(doc(doc_id))}],
    )
    block = first_tool_use(response)
    return Invoice.model_validate(block.input)  # tool input is already a dict: no json.loads


def main() -> None:
    lab.banner("D4.3  Schema design: nullable, other + detail, unclear, format rules")
    offline = not lab.is_live()

    lab.section("A. Field absent from the document (inv-002 has no date, no PO)")
    good = extract("inv-002", invoice_tool())
    bad = extract("inv-002", invoice_tool(nullable_fields=False))
    print(f"  nullable schema : invoice_date={good.invoice_date!r:<14} po_number={good.po_number!r}")
    print(f"  required strings: invoice_date={bad.invoice_date!r:<14} po_number={bad.po_number!r}")
    lab.check(good.invoice_date is None and good.po_number is None, "nullable fields: the model returns null instead of inventing")
    if offline:
        source = doc("inv-002")["text"]
        lab.check(
            bad.invoice_date is not None and bad.invoice_date not in source and bad.po_number == bad.invoice_number,
            "required non-null fields: a date that is not in the document, and the invoice number reused as PO",
        )

    lab.section('B. Category not in the list (inv-003, catering)')
    with_other = extract("inv-003", invoice_tool())
    without_other = extract("inv-003", invoice_tool(with_other=False, with_unclear=False))
    print(f"  enum + other : category={with_other.category!r} category_detail={with_other.category_detail!r}")
    print(f"  enum only    : category={without_other.category!r} category_detail={without_other.category_detail!r}")
    if offline:
        lab.check(with_other.category == "other" and with_other.category_detail == "event catering", '"other" + detail keeps the real category')
        lab.check(without_other.category == "travel", "without 'other' the spend is silently misfiled")

    lab.section('C. Not enough information to categorize (inv-004, "Q3 services bundle")')
    with_unclear = extract("inv-004", invoice_tool())
    without_unclear = extract("inv-004", invoice_tool(with_unclear=False))
    print(f"  enum + unclear: {with_unclear.category!r}")
    print(f"  no unclear    : {without_unclear.category!r}  (other needs a detail it does not have)")
    if offline:
        lab.check(with_unclear.category == "unclear", '"unclear" lets the model flag ambiguity for review')
        lab.check(without_unclear.category not in ("unclear", "other"), "without it, a guess looks exactly like a fact")

    lab.section("D. Format normalization rules in the prompt")
    for doc_id in ("inv-001", "inv-004"):
        raw = extract(doc_id, invoice_tool(), system=SYSTEM_BASE)
        norm = extract(doc_id, invoice_tool(), system=SYSTEM_WITH_RULES)
        print(f"  {doc_id} no rules  : invoice_date={raw.invoice_date!r:<16} currency={raw.currency!r}")
        print(f"  {doc_id} with rules: invoice_date={norm.invoice_date!r:<16} currency={norm.currency!r}")
        if offline:
            lab.check(
                raw.invoice_date != norm.invoice_date and norm.invoice_date is not None and len(norm.invoice_date) == 10,
                f"{doc_id}: the schema allowed any string; the prompt rule produced ISO 8601",
            )
            lab.check(len(norm.currency) == 3 and norm.currency.isupper(), f"{doc_id}: currency normalized to an ISO 4217 code")


if __name__ == "__main__":
    main()
