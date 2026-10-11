"""D4.3 - Tool use removes JSON SYNTAX errors; it does not remove SEMANTIC errors.

    "return JSON" in the prompt -> prose + ``` fences + trailing commas -> json.loads fails
    strict tool use             -> tool_use.input is always schema-valid -> 0 syntax errors
    ...but schema-valid != correct: line items that don't add up, a PO number sitting in
    invoice_number. A local semantic validator has to catch those.

Run:  python syntax_vs_semantic.py          (offline, scripted model)
      python syntax_vs_semantic.py --live   (real Claude API)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from extraction_tools import INVOICE_TOOL, SYSTEM_WITH_RULES, Invoice, doc, document_message, first_tool_use, semantic_errors  # noqa: E402
from scripted_extractor import scripted_extractor  # noqa: E402

DOC_IDS = ["inv-001", "inv-004", "inv-005"]


def try_parse(text: str) -> tuple[bool, str]:
    try:
        json.loads(text)
        return True, "ok"
    except json.JSONDecodeError as exc:
        return False, f"{exc.msg} (line {exc.lineno})"


def strip_fences(text: str) -> str:
    """The usual band-aid: cut out the ```json block. Still fails on hand-written JSON errors."""
    m = re.search(r"```(?:json)?\n(.*?)\n```", text, flags=re.DOTALL)
    return m.group(1) if m else text


def main() -> None:
    lab.banner("D4.3  Syntax errors vs semantic errors")
    client = lab.get_client(scripted_extractor)

    lab.section('A. No tools, "Return the invoice as JSON" in the prompt')
    naive_failures = cleaned_failures = 0
    for doc_id in DOC_IDS:
        response = client.messages.create(
            model=lab.MODEL,
            max_tokens=4000,
            system=SYSTEM_WITH_RULES + "\nReturn the invoice as a JSON object.",
            messages=[{"role": "user", "content": document_message(doc(doc_id))}],
        )
        text = lab.text_of(response)
        ok_naive, why_naive = try_parse(text)
        ok_clean, why_clean = try_parse(strip_fences(text))
        naive_failures += not ok_naive
        cleaned_failures += not ok_clean
        print(f"  {doc_id}: json.loads -> {why_naive:<40} after stripping fences -> {why_clean}")
    print(f"  syntax failures: {naive_failures}/3 raw, {cleaned_failures}/3 even after clean-up")

    lab.section("B. Strict tool use: read tool_use.input")
    parsed: dict[str, Invoice] = {}
    for doc_id in DOC_IDS:
        response = client.messages.create(
            model=lab.MODEL,
            max_tokens=4000,
            system=SYSTEM_WITH_RULES,
            tools=[INVOICE_TOOL],  # strict: True -> input is guaranteed to match input_schema
            messages=[{"role": "user", "content": document_message(doc(doc_id))}],
        )
        block = first_tool_use(response)
        if block is not None:
            parsed[doc_id] = Invoice.model_validate(block.input)
        print(f"  {doc_id}: {'schema-valid input' if block else 'NO tool_use (auto mode - see modern_structured_output.py)'}")

    lab.section("C. Semantic validation of the schema-valid output")
    for doc_id, inv in parsed.items():
        errors = semantic_errors(inv)
        print(f"  {doc_id}: {errors or 'no semantic errors'}")

    if not lab.is_live():
        lab.check(naive_failures == 3, "JSON-in-text: every reply needs post-processing (prose and fences around the JSON)")
        lab.check(cleaned_failures >= 1, "stripping fences is not enough: hand-written JSON still has syntax errors")
        lab.check(len(parsed) == 3, "tool use: all 3 extractions parsed with zero syntax errors")
        inv5 = semantic_errors(parsed["inv-005"])
        lab.check(any("sum to" in e for e in inv5), "...yet inv-005's line items (1,150) do not add up to its total (1,200)")
        lab.check(any("purchase-order" in e for e in inv5), "...and a PO number landed in invoice_number (value in the wrong field)")
        lab.check(not semantic_errors(parsed["inv-001"]) and not semantic_errors(parsed["inv-004"]), "clean documents pass the semantic checks")


if __name__ == "__main__":
    main()
