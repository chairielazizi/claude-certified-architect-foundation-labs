"""The workload for D4.5: 24 supplier contracts for an overnight renewal report.

Holds the document generator, the two prompt versions (v1 before refinement, v2 after), the
offline extraction model, request building with custom_id, output validation, and the
chunk / merge helpers used when a document is too long for one request.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

SUPPLIERS = [
    "Northwind Office Supply", "Bluepeak Consulting", "Harbor Catering", "Atlas Hardware",
    "Meridian Group", "Orbit Cloud", "Kestrel Print Works", "Granite Facilities",
]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
OVERSIZED = "doc-017"

PROMPT_V1 = "Extract the supplier, renewal date, whether the contract auto-renews, and the notice period in days. Reply in JSON."
PROMPT_V2 = (
    'Extract fields from the contract. Respond with JSON only: {"supplier": string|null, '
    '"renewal_date": "YYYY-MM-DD"|null, "auto_renews": true|false|null, "notice_days": integer|null}. '
    "The document may be one part of a longer contract: use null for anything not in this part. Never guess."
)


def make_documents(n: int = 24) -> list[dict[str, Any]]:
    docs = []
    for i in range(1, n + 1):
        doc_id = f"doc-{i:03d}"
        month, day = i % 12 + 1, (i * 7) % 28 + 1
        iso = f"2027-{month:02d}-{day:02d}"
        printed = f"{day} {MONTHS[month - 1]} 2027" if i % 3 == 0 else iso  # every 3rd doc spells the date out
        clauses = 160 if doc_id == OVERSIZED else 4 + i % 5
        lines = [
            f"DOCUMENT {doc_id}",
            f"Supplier: {SUPPLIERS[(i - 1) % len(SUPPLIERS)]}",
            f"Renewal date: {printed}",
            f"Auto-renewal: {'yes' if i % 2 == 0 else 'no'}",
            *[
                f"Clause {k}. The supplier shall provide the services described in schedule {k} in line with the "
                "agreed service levels, security requirements, data-protection terms and monthly reporting obligations."
                for k in range(1, clauses + 1)
            ],
            f"Notice period: {30 + (i % 4) * 15} days",  # at the END: in the last part once chunked
        ]
        truth = {
            "supplier": SUPPLIERS[(i - 1) % len(SUPPLIERS)],
            "renewal_date": iso,
            "auto_renews": i % 2 == 0,
            "notice_days": 30 + (i % 4) * 15,
        }
        docs.append({"id": doc_id, "text": "\n".join(lines), "truth": truth})
    return docs


class ContractFields(BaseModel):
    # strict: "yes" is not a bool, "45" is not an int - format drift counts as a failure.
    model_config = ConfigDict(extra="forbid", strict=True)
    supplier: str | None
    renewal_date: str | None
    auto_renews: bool | None
    notice_days: int | None

    @field_validator("renewal_date")
    @classmethod
    def _iso(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError(f"must be YYYY-MM-DD, got {value!r}")
        return value


def parse_output(text: str) -> tuple[ContractFields | None, str]:
    start, end = text.find("{"), text.rfind("}")  # tolerate prose around the JSON
    try:
        return ContractFields.model_validate(json.loads(text[start : end + 1])), "ok"
    except json.JSONDecodeError:
        return None, "not JSON"
    except ValidationError as exc:
        err = exc.errors()[0]
        return None, f"{'.'.join(str(p) for p in err['loc'])}: {err['msg'].removeprefix('Value error, ')}"


def build_request(custom_id: str, text: str, system: str = PROMPT_V2) -> dict[str, Any]:
    """One batch entry. Python SDK equivalent: Request(custom_id=..., params=MessageCreateParamsNonStreaming(...))."""
    return {
        "custom_id": custom_id,
        "params": {
            "model": lab.MODEL,
            "max_tokens": 1024,
            "system": system,
            "messages": [{"role": "user", "content": f"<document>\n{text}\n</document>"}],
        },
    }


def chunk_document(doc_id: str, text: str, max_tokens: int) -> list[tuple[str, str]]:
    """Split on line boundaries into parts under max_tokens; ids like doc-017#p1."""
    parts: list[list[str]] = [[]]
    size = 0
    for line in text.split("\n"):
        if size + len(line) // 4 > max_tokens and parts[-1]:
            parts.append([])
            size = 0
        parts[-1].append(line)
        size += len(line) // 4 + 1
    return [(f"{doc_id}#p{n}", "\n".join(lines)) for n, lines in enumerate(parts, 1)]


def merge_parts(parts: list[ContractFields]) -> ContractFields:
    """First non-null value per field, in part order (header facts in p1, notice in the last part)."""
    merged: dict[str, Any] = {}
    for field in ContractFields.model_fields:
        merged[field] = next((getattr(p, field) for p in parts if getattr(p, field) is not None), None)
    return ContractFields.model_validate(merged)


# ---------------------------------------------------------------------------
# Offline model
# ---------------------------------------------------------------------------


def _to_iso(raw: str) -> str:
    m = re.fullmatch(r"(\d{1,2}) ([A-Za-z]+) (\d{4})", raw)
    return f"{m[3]}-{MONTHS.index(m[2]) + 1:02d}-{int(m[1]):02d}" if m else raw


def extraction_model(params: dict[str, Any]) -> lab.Obj:
    """Follows the prompt it is given: v1 copies dates as printed, v2 normalizes and uses null."""
    system = lab.system_text(params)
    text = re.search(r"<document>\n(.*)\n</document>", lab.last_user_text(params), flags=re.DOTALL)[1]  # type: ignore[index]

    def field(label: str) -> str | None:
        m = re.search(rf"^{label}: (.+)$", text, flags=re.MULTILINE)
        return m[1].strip() if m else None

    supplier, raw_date, auto = field("Supplier"), field("Renewal date"), field("Auto-renewal")
    notice = re.search(r"Notice period: (\d+) days", text)
    if params.get("tools"):
        # Asked to look something up first: the turn ends with a tool call. In a batch there is no
        # one to run it - the request is simply finished with stop_reason "tool_use".
        return lab.message(lab.tool_use(params["tools"][0]["name"], {"supplier": supplier}))
    data = {
        "supplier": supplier,
        "renewal_date": (_to_iso(raw_date) if "YYYY-MM-DD" in system else raw_date) if raw_date else None,
        "auto_renews": (auto == "yes") if auto else None,
        "notice_days": int(notice[1]) if notice else None,
    }
    return lab.message(lab.text(json.dumps(data)))
