"""Offline stand-in for Claude doing extraction (D4.3).

It reads the document with simple parsers, and decides HOW to answer the way the API
contract says the real model must:

  tool_choice {"type": "tool", "name": X} -> calls X, nothing else
  tool_choice {"type": "any"}             -> calls one of the tools; picks the one that fits
  tool_choice {"type": "auto"} (default)  -> may answer in text instead: when nobody asked for a
                                             tool, or when the document asks a question and the
                                             latest turn does not name a tool
  output_config.format json_schema        -> the answer IS the JSON text
  no tools, "return JSON"                 -> hand-written JSON in prose + fences (syntax risk)

What it extracts also depends on the request: format rules in the system prompt turn on
ISO dates / currency codes; the schema decides between null and an invented value, and
which category buckets exist.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from extraction_tools import INVOICE_TOOL  # noqa: E402

MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
CATEGORY_KEYWORDS = [
    ("office_supplies", ["paper", "toner", "stationery"]),
    ("software", ["license", "subscription"]),
    ("hardware", ["laptop", "monitor", "dock"]),
    ("professional_services", ["workshop", "consulting", "audit"]),
    ("travel", ["flight", "hotel", "taxi"]),
]
OTHER_HINTS = {"catering": "event catering"}


def to_iso(raw: str) -> str:
    raw = raw.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return raw
    if m := re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", raw):  # day/month/year per the rules
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
    elif m := re.match(r"^([A-Za-z]+) (\d{1,2}), (\d{4})$", raw):
        d, mo, y = int(m[2]), MONTHS[m[1][:3].lower()], int(m[3])
    elif m := re.match(r"^(\d{1,2}) ([A-Za-z]+) (\d{4})$", raw):
        d, mo, y = int(m[1]), MONTHS[m[2][:3].lower()], int(m[3])
    else:
        return raw
    return f"{y:04d}-{mo:02d}-{d:02d}"


def _field(text: str, label: str) -> str | None:
    m = re.search(rf"^{re.escape(label)}: (.+)$", text, flags=re.MULTILINE)
    return m.group(1).strip() if m else None


def _money(value: str) -> float:
    return float(value.replace(",", ""))


def _is_nullable(prop: dict[str, Any]) -> bool:
    return any(option.get("type") == "null" for option in prop.get("anyOf", []))


def _categorize(text: str, enum: list[str]) -> tuple[str, str | None]:
    lower = text.lower()
    for category, words in CATEGORY_KEYWORDS:
        if any(w in lower for w in words):
            return category, None
    for hint, detail in OTHER_HINTS.items():
        if hint in lower:
            # Without an "other" bucket the model must force it into a wrong one.
            return ("other", detail) if "other" in enum else ("travel", None)
    # Not enough information to choose: "unclear" if allowed, otherwise a guess dressed as fact.
    return ("unclear", None) if "unclear" in enum else ("professional_services", None)


def parse_invoice(text: str, schema: dict[str, Any], rules: bool) -> dict[str, Any]:
    props = schema["properties"]
    total_m = re.match(r"^(\$|[A-Z]{3})\s?([\d,]+\.\d{2})$", _field(text, "Total due") or "")
    symbol, total = (total_m[1], _money(total_m[2])) if total_m else ("", 0.0)
    raw_date = _field(text, "Invoice date")
    category, detail = _categorize(text, props["category"]["enum"])
    out: dict[str, Any] = {
        "vendor_name": _field(text, "Vendor") or "",
        # A literal reader puts whatever "reference" it finds into invoice_number.
        "invoice_number": _field(text, "Invoice #") or _field(text, "Ref"),
        "invoice_date": (to_iso(raw_date) if rules else raw_date) if raw_date else None,
        "po_number": _field(text, "PO"),
        "currency": {"$": "USD"}.get(symbol, symbol) if rules else symbol,
        "category": category,
        "category_detail": detail,
        "line_items": [
            {"description": d.strip(), "quantity": float(q), "unit_price": _money(p), "amount": _money(a)}
            for q, d, p, a in re.findall(r"^- (\d+(?:\.\d+)?) x (.+?) @ ([\d,]+\.\d{2}) = ([\d,]+\.\d{2})$", text, flags=re.MULTILINE)
        ],
        "total": total,
    }
    # A field the document lacks: null if the schema allows it, otherwise invent something
    # plausible to satisfy "required" - the fabrication the exam warns about.
    fabricated = {"invoice_date": "2026-03-01", "po_number": out["invoice_number"]}
    for key, invented in fabricated.items():
        if out[key] is None and not _is_nullable(props[key]):
            out[key] = invented
    return out


def parse_receipt(text: str, schema: dict[str, Any], rules: bool) -> dict[str, Any]:
    raw_date = re.search(r"\b(\d{2}/\d{2}/\d{4})\b", text)
    total = re.search(r"^TOTAL (\d+\.\d{2})$", text, flags=re.MULTILINE)
    return {
        "merchant": text.split("\n", 1)[0].strip(),
        "date": (to_iso(raw_date[1]) if rules else raw_date[1]) if raw_date else None,
        "currency": None,  # the receipt prints no currency: null, not a guess
        "items": [
            {"description": d, "amount": float(a)}
            for _, d, a in re.findall(r"^(\d+) (.+?) (\d+\.\d{2})$", text, flags=re.MULTILINE)
        ],
        "total": float(total[1]) if total else 0.0,
        "payment_method": "card" if re.search(r"VISA|MASTERCARD|AMEX", text) else ("cash" if "CASH" in text else "unclear"),
    }


def parse_contract(text: str, schema: dict[str, Any], rules: bool) -> dict[str, Any]:
    parties = re.search(r'between (.+?) \("(\w+)"\) and (.+?) \("(\w+)"\)', text)
    raw_date = _field(text, "Effective date")
    term = re.search(r"^Term: (\d+) months$", text, flags=re.MULTILINE)
    return {
        "title": text.split("\n", 1)[0].strip().title(),
        "parties": [{"name": parties[1], "role": parties[2]}, {"name": parties[3], "role": parties[4]}] if parties else [],
        "effective_date": (to_iso(raw_date) if rules else raw_date) if raw_date else None,
        "term_months": int(term[1]) if term else None,
        "governing_law": _field(text, "Governing law"),
    }


def detect_type(text: str) -> str:
    first = text.split("\n", 1)[0].upper()
    if "INVOICE" in first:
        return "invoice"
    if "AGREEMENT" in first or "CONTRACT" in first:
        return "contract"
    if re.search(r"^TOTAL ", text, flags=re.MULTILINE):
        return "receipt"
    return "unclear"


def parse_metadata(text: str, schema: dict[str, Any], rules: bool) -> dict[str, Any]:
    return {
        "doc_type": detect_type(text),
        "language": "en",
        "has_signature": "Signed:" in text,
        "mentions_amounts": bool(re.search(r"\d+\.\d{2}", text)),
    }


PARSERS: dict[str, Callable[[str, dict[str, Any], bool], dict[str, Any]]] = {
    "extract_invoice": parse_invoice,
    "extract_receipt": parse_receipt,
    "extract_contract": parse_contract,
    "extract_metadata": parse_metadata,
}


def _prose_json(data: dict[str, Any]) -> str:
    """How JSON-in-text tends to come back when no schema constrains it."""
    body = json.dumps(data, indent=2)
    if len(data.get("line_items", [])) > 1:
        body = body.replace("}\n  ],", "},\n  ],", 1)  # hand-written trailing comma
    return f"Here is the extracted invoice data:\n```json\n{body}\n```\nLet me know if you need anything else."


def scripted_extractor(params: dict[str, Any]) -> lab.Obj:
    system = lab.system_text(params)
    tools = params.get("tools") or []
    names = [t["name"] for t in tools]
    choice = params.get("tool_choice") or {"type": "auto"}
    first = params["messages"][0]["content"]
    first_text = first if isinstance(first, str) else "".join(b.get("text", "") for b in first)
    document = re.search(r"<document>\n(.*)\n</document>", first_text, flags=re.DOTALL)[1]  # type: ignore[index]
    latest = lab.last_user_text(params)
    rules = "ISO 8601" in system
    doc_type = detect_type(document)

    fmt = (params.get("output_config") or {}).get("format")
    if fmt:  # structured outputs: the text block is guaranteed to match the schema
        return lab.message(lab.text(json.dumps(parse_invoice(document, fmt["schema"], rules))))

    if not tools:  # "return JSON" with no schema: prose, fences, the odd trailing comma
        return lab.message(lab.text(_prose_json(parse_invoice(document, INVOICE_TOOL["input_schema"], rules))))

    if choice["type"] == "none":
        return lab.message(lab.text(f"Document type: {doc_type}."))
    if choice["type"] == "tool":
        name = choice["name"]
    elif choice["type"] == "any":
        name = f"extract_{doc_type}" if f"extract_{doc_type}" in names else names[0]
    else:  # auto: the model decides whether a tool call is the right response
        named = next((n for n in names if n in latest), None)
        question = re.search(r"^Note[^:\n]*: .*\?$", document, flags=re.MULTILINE)
        if named:
            name = named
        elif "tool" not in (system + latest).lower():
            return lab.message(lab.text(f"Got it - document type: {doc_type}. Want me to pull out the details?"))
        elif question:
            return lab.message(
                lab.text("I can't confirm a delivery address from this invoice; please check with the vendor directly.")
            )
        elif f"extract_{doc_type}" in names:
            name = f"extract_{doc_type}"
        else:
            return lab.message(lab.text(f"None of the tools fits a {doc_type}."))

    schema = next(t["input_schema"] for t in tools if t["name"] == name)
    return lab.message(lab.tool_use(name, PARSERS[name](document, schema, rules)))
