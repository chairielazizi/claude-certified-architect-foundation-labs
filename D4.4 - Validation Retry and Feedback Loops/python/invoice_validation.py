"""Validation for D4.4: pydantic model with semantic validators + retryable/not-retryable triage.

The extraction carries BOTH stated_total (what the document says) and calculated_total (what
the line items add up to) plus conflict_detected. That turns "the numbers disagree" into data:
  * model arithmetic wrong   -> calculated_total != sum(items)     -> retry with the error
  * the SOURCE is inconsistent -> conflict_detected = true          -> accept, flag for review
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
INVOICES: list[dict[str, Any]] = json.loads((FIXTURES / "invoices.json").read_text(encoding="utf-8"))["invoices"]

ISO_4217 = {"USD", "EUR", "GBP", "SGD", "JPY", "AUD", "CAD", "CHF"}

SYSTEM = (
    "Extract the invoice by calling extract_invoice. Compute calculated_total yourself by adding the "
    "line-item amounts, copy the printed total into stated_total, and set conflict_detected when they "
    "differ. If a value is not in the document, use null and say why in the matching *_missing_reason field."
)

EXTRACT_TOOL: dict[str, Any] = {
    "name": "extract_invoice",
    "description": "Record one invoice.",
    "input_schema": {
        "type": "object",
        "properties": {
            "invoice_number": {"type": "string"},
            "vendor_name": {"type": "string"},
            "invoice_date": {"type": "string", "description": "YYYY-MM-DD"},
            "currency": {"type": "string", "description": "ISO 4217 code"},
            "po_number": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "po_number_missing_reason": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "line_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "description": {"type": "string"},
                        "quantity": {"type": "number"},
                        "unit_price": {"type": "number"},
                        "amount": {"type": "number"},
                    },
                    "required": ["description", "quantity", "unit_price", "amount"],
                },
            },
            "stated_total": {"type": "number", "description": "Total exactly as printed"},
            "calculated_total": {"type": "number", "description": "Sum of line_items[].amount, computed by you"},
            "conflict_detected": {"type": "boolean", "description": "true when stated_total != calculated_total"},
        },
        "required": [
            "invoice_number", "vendor_name", "invoice_date", "currency", "po_number",
            "po_number_missing_reason", "line_items", "stated_total", "calculated_total", "conflict_detected",
        ],
    },
}


class LineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str
    quantity: float
    unit_price: float
    amount: float


class InvoiceExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invoice_number: str
    vendor_name: str
    invoice_date: str
    currency: str
    po_number: str | None
    po_number_missing_reason: str | None
    line_items: list[LineItem] = Field(min_length=1)
    stated_total: float
    calculated_total: float
    conflict_detected: bool

    @field_validator("invoice_date")
    @classmethod
    def _iso_date(cls, value: str) -> str:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError(f"must be ISO 8601 YYYY-MM-DD, got {value!r}")
        date.fromisoformat(value)  # also rejects 2026-02-30
        return value

    @field_validator("currency")
    @classmethod
    def _iso_currency(cls, value: str) -> str:
        if value not in ISO_4217:
            raise ValueError(f"must be an ISO 4217 code such as USD, EUR or GBP, got {value!r}")
        return value

    @model_validator(mode="after")
    def _totals(self) -> InvoiceExtraction:
        items = round(sum(item.amount for item in self.line_items), 2)
        if abs(items - self.calculated_total) > 0.01:
            raise ValueError(f"calculated_total {self.calculated_total} != sum of line_items {items}")
        conflict = abs(self.calculated_total - self.stated_total) > 0.01
        if conflict != self.conflict_detected:
            raise ValueError(f"conflict_detected must be {str(conflict).lower()} for these totals")
        return self


@dataclass
class Issue:
    field: str
    message: str
    kind: str  # format | structural | arithmetic | missing_required


# Where the source would show the value if it were there. Used to decide whether a retry can help.
EVIDENCE = {"po_number": r"\bPO-\d+\b"}


def validate(data: dict[str, Any] | None) -> tuple[InvoiceExtraction | None, list[Issue]]:
    """Schema + semantic validation, then business completeness (PO needed to pay)."""
    if data is None:
        return None, [Issue("(response)", "no extract_invoice call in the response", "structural")]
    try:
        inv = InvoiceExtraction.model_validate(data)
    except ValidationError as exc:
        issues = []
        for err in exc.errors():
            field = ".".join(str(p) for p in err["loc"]) or "(totals)"
            msg = err["msg"].removeprefix("Value error, ")
            kind = "format" if field in ("invoice_date", "currency") else "arithmetic" if field == "(totals)" else "structural"
            issues.append(Issue(field, msg, kind))
        return None, issues
    if inv.po_number is None:
        return inv, [Issue("po_number", "required for payment: accounts payable matches on PO number", "missing_required")]
    return inv, []


def is_retryable(issue: Issue, document: str) -> bool:
    """Retry fixes OUTPUT mistakes. It cannot conjure information the source does not contain."""
    if issue.kind in ("format", "structural", "arithmetic"):
        return True
    pattern = EVIDENCE.get(issue.field)
    return bool(pattern and re.search(pattern, document))  # the value IS in the document: worth a retry


def feedback_text(issues: list[Issue]) -> str:
    lines = "\n".join(f"- {i.field}: {i.message}" for i in issues)
    return (
        "The extraction failed validation:\n"
        f"{lines}\n"
        "Re-read the document and call extract_invoice again. Fix only these fields; keep the rest unchanged."
    )
