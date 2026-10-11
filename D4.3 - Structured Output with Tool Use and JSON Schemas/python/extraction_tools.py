"""Extraction tools for D4.3: the tool's input_schema IS the output schema.

Design choices shown here:
  * every property is listed in "required" and objects set additionalProperties: false
    (what strict: true expects); "optional" is expressed as NULLABLE, so the model can
    say "not in the document" instead of inventing a value
  * enum + "other" + category_detail for extensible categories, plus "unclear"
  * format rules (ISO dates, ISO 4217 currency) live in the PROMPT, next to the schema:
    a schema can say "string", it cannot say which of five date spellings to use
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
DOCS: list[dict[str, Any]] = json.loads((FIXTURES / "documents.json").read_text(encoding="utf-8"))["documents"]


def doc(doc_id: str) -> dict[str, Any]:
    return next(d for d in DOCS if d["id"] == doc_id)


def document_message(d: dict[str, Any], instruction: str = "") -> str:
    return f"{instruction}\n<document>\n{d['text']}\n</document>".lstrip()


SYSTEM_BASE = "You extract data from business documents by calling the matching extraction tool."

FORMAT_RULES = """Rules:
- Use only information in the document. If a field is not in the document, use null. Never guess.
- Dates: ISO 8601 (YYYY-MM-DD). Numeric dates in these documents are day/month/year.
- currency: ISO 4217 code. "$" means USD; "EUR" and "GBP" are already codes.
- Amounts: plain numbers, no currency symbols or thousands separators.
- category: if none fits, use "other" and say what it is in category_detail; if the document
  does not say enough to choose, use "unclear"."""

SYSTEM_WITH_RULES = f"{SYSTEM_BASE}\n\n{FORMAT_RULES}"


def nullable(schema: dict[str, Any], description: str) -> dict[str, Any]:
    # anyOf [T, null] is the nullable form structured outputs / strict tools accept.
    return {"anyOf": [schema, {"type": "null"}], "description": description}


def _obj(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


CATEGORIES = ["office_supplies", "software", "hardware", "professional_services", "travel"]


def invoice_tool(*, nullable_fields: bool = True, with_other: bool = True, with_unclear: bool = True) -> dict[str, Any]:
    """extract_invoice. The keyword flags build the 'bad design' variants for comparison."""

    def maybe_null(schema: dict[str, Any], description: str) -> dict[str, Any]:
        return nullable(schema, description) if nullable_fields else {**schema, "description": description}

    enum = CATEGORIES + (["other"] if with_other else []) + (["unclear"] if with_unclear else [])
    line_item = _obj(
        {
            "description": {"type": "string"},
            "quantity": {"type": "number"},
            "unit_price": {"type": "number"},
            "amount": {"type": "number"},
        }
    )
    return {
        "name": "extract_invoice",
        "description": "Record the fields of a supplier INVOICE. Call once per invoice.",
        "strict": True,
        "input_schema": _obj(
            {
                "vendor_name": {"type": "string", "description": "Supplier name as printed. Always present on an invoice."},
                "invoice_number": nullable({"type": "string"}, "The supplier's invoice number. Not a PO number."),
                "invoice_date": maybe_null({"type": "string"}, "Invoice date, YYYY-MM-DD; null if not stated."),
                "po_number": maybe_null({"type": "string"}, "Buyer's purchase-order number; null if not stated."),
                "currency": {"type": "string", "description": "ISO 4217 code, e.g. USD."},
                "category": {"type": "string", "enum": enum},
                "category_detail": nullable({"type": "string"}, "What the spend is when category is 'other'."),
                "line_items": {"type": "array", "items": line_item},
                "total": {"type": "number", "description": "Total due as printed."},
            }
        ),
    }


RECEIPT_TOOL: dict[str, Any] = {
    "name": "extract_receipt",
    "description": "Record the fields of a point-of-sale RECEIPT (shop, cafe, taxi).",
    "strict": True,
    "input_schema": _obj(
        {
            "merchant": {"type": "string"},
            "date": nullable({"type": "string"}, "YYYY-MM-DD; null if not printed."),
            "currency": nullable({"type": "string"}, "ISO 4217 code; null if the receipt shows none."),
            "items": {"type": "array", "items": _obj({"description": {"type": "string"}, "amount": {"type": "number"}})},
            "total": {"type": "number"},
            "payment_method": {"type": "string", "enum": ["card", "cash", "other", "unclear"]},
        }
    ),
}

CONTRACT_TOOL: dict[str, Any] = {
    "name": "extract_contract",
    "description": "Record the key terms of a CONTRACT or agreement.",
    "strict": True,
    "input_schema": _obj(
        {
            "title": {"type": "string"},
            "parties": {"type": "array", "items": _obj({"name": {"type": "string"}, "role": {"type": "string"}})},
            "effective_date": nullable({"type": "string"}, "YYYY-MM-DD; null if not stated."),
            "term_months": nullable({"type": "integer"}, "Contract term in months; null if open-ended or not stated."),
            "governing_law": nullable({"type": "string"}, "Jurisdiction; null if not stated."),
        }
    ),
}

METADATA_TOOL: dict[str, Any] = {
    "name": "extract_metadata",
    "description": "Classify a document before any detailed extraction. Always the first step of the pipeline.",
    "strict": True,
    "input_schema": _obj(
        {
            "doc_type": {"type": "string", "enum": ["invoice", "receipt", "contract", "other", "unclear"]},
            "language": {"type": "string", "description": "ISO 639-1 code"},
            "has_signature": {"type": "boolean"},
            "mentions_amounts": {"type": "boolean"},
        }
    ),
}

INVOICE_TOOL = invoice_tool()
EXTRACTION_TOOLS = [INVOICE_TOOL, RECEIPT_TOOL, CONTRACT_TOOL]


# ---------------------------------------------------------------------------
# Typed parsing of tool input + semantic validation
# ---------------------------------------------------------------------------


class LineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str
    quantity: float
    unit_price: float
    amount: float


class Invoice(BaseModel):
    """Mirrors extract_invoice's schema. Parsing proves SHAPE, not correctness."""

    model_config = ConfigDict(extra="forbid")
    vendor_name: str
    invoice_number: str | None
    invoice_date: str | None
    po_number: str | None
    currency: str
    category: Literal["office_supplies", "software", "hardware", "professional_services", "travel", "other", "unclear"]
    category_detail: str | None
    line_items: list[LineItem]
    total: float


def semantic_errors(inv: Invoice) -> list[str]:
    """Checks a JSON schema cannot express. Strict tool use guarantees none of these."""
    errors = []
    for i, item in enumerate(inv.line_items):
        if abs(item.quantity * item.unit_price - item.amount) > 0.01:
            errors.append(f"line_items[{i}]: {item.quantity} x {item.unit_price} != {item.amount}")
    items_sum = round(sum(item.amount for item in inv.line_items), 2)
    if abs(items_sum - inv.total) > 0.01:
        errors.append(f"line items sum to {items_sum:.2f} but total is {inv.total:.2f}")
    if inv.invoice_number and re.match(r"^PO-", inv.invoice_number):
        errors.append(f"invoice_number {inv.invoice_number!r} looks like a purchase-order number (wrong field?)")
    if inv.category == "other" and not inv.category_detail:
        errors.append("category is 'other' but category_detail is empty")
    if inv.invoice_date and not re.match(r"^\d{4}-\d{2}-\d{2}$", inv.invoice_date):
        errors.append(f"invoice_date {inv.invoice_date!r} is not YYYY-MM-DD")
    if not re.match(r"^[A-Z]{3}$", inv.currency):
        errors.append(f"currency {inv.currency!r} is not an ISO 4217 code")
    return errors


def first_tool_use(response: Any) -> Any | None:
    """The structured data lives in the tool_use block's .input (already parsed JSON)."""
    return next((b for b in response.content if b.type == "tool_use"), None)
