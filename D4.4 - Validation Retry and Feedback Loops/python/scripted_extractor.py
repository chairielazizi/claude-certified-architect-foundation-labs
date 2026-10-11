"""Offline stand-in for Claude in D4.4's extraction loop.

First pass: copies values the way they are printed (so "14/03/2026" and "US dollars" fail
validation) - a realistic first-pass miss. On a retry it reads the tool_result error list and
fixes exactly the fields that were named, nothing else. It cannot fix what the document does
not contain: a PO number that lives in "the attached purchase order" stays null however
many times you ask.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

CURRENCY_WORDS = {"us dollars": "USD", "euros": "EUR", "pounds sterling": "GBP"}


def _iso(raw: str) -> str:
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    return f"{m[3]}-{int(m[2]):02d}-{int(m[1]):02d}" if m else raw


def _money(value: str) -> float:
    return float(value.replace(",", ""))


def first_pass(text: str) -> dict[str, Any]:
    def field(label: str) -> str | None:
        m = re.search(rf"^{label}: (.+)$", text, flags=re.MULTILINE)
        return m[1].strip() if m else None

    items = [
        {"description": d.strip(), "quantity": float(q), "unit_price": _money(p), "amount": _money(a)}
        for q, d, p, a in re.findall(r"^- (\d+) x (.+?) @ ([\d,]+\.\d{2}) = ([\d,]+\.\d{2})$", text, flags=re.MULTILINE)
    ]
    calculated = round(sum(i["amount"] for i in items), 2)
    stated = _money(field("Total") or "0")
    po_line = field("PO number") or ""
    po = re.search(r"\bPO-\d+\b", po_line)
    return {
        "invoice_number": re.search(r"^INVOICE (\S+)", text)[1],  # type: ignore[index]
        "vendor_name": field("Vendor"),
        "invoice_date": field("Invoice date"),  # copied as printed
        "currency": field("Currency"),  # copied as printed
        "po_number": po[0] if po else None,
        "po_number_missing_reason": None if po else f"The document says '{po_line}', and that document was not provided.",
        "line_items": items,
        "stated_total": stated,
        "calculated_total": calculated,
        "conflict_detected": abs(calculated - stated) > 0.01,
    }


def scripted_extractor(params: dict[str, Any]) -> lab.Obj:
    document = re.search(r"<document>\n(.*)\n</document>", params["messages"][0]["content"], flags=re.DOTALL)[1]  # type: ignore[index]
    data = first_pass(document)

    errors = [r for r in lab.tool_results(params) if r.get("is_error")]
    if errors:
        # Retry: fix exactly the fields named in the feedback.
        named = set(re.findall(r"^- (\w+):", str(errors[-1]["content"]), flags=re.MULTILINE))
        if "invoice_date" in named:
            data["invoice_date"] = _iso(data["invoice_date"])
        if "currency" in named:
            data["currency"] = CURRENCY_WORDS.get(str(data["currency"]).lower(), data["currency"])
        # "po_number" may be named too, but there is nothing in the document to fix it with.
    return lab.message(lab.tool_use("extract_invoice", data))
