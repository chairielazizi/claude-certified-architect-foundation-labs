"""D4.3 - Guaranteed structure on claude-opus-5-5, which rejects forced tool_choice.

    1. Structured outputs: output_config.format = json_schema -> the text block IS valid JSON
    2. strict: true tool + tool_choice auto + a prompt that names the tool
       -> verify a tool_use came back; if not, re-prompt (auto never guarantees a call)

Both run on lab.MODEL. Forced "any"/"tool" (tool_choice_modes.py) needs
lab.FORCED_TOOL_CHOICE_MODEL instead.

Run:  python modern_structured_output.py          (offline, scripted model)
      python modern_structured_output.py --live   (real Claude API)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from extraction_tools import FORMAT_RULES, INVOICE_TOOL, SYSTEM_WITH_RULES, Invoice, doc, document_message, first_tool_use  # noqa: E402
from scripted_extractor import scripted_extractor  # noqa: E402

MAX_REPROMPTS = 1


def extract_structured_output(client: Any, doc_id: str) -> Invoice:
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=4000,
        system=f"You extract data from business documents.\n\n{FORMAT_RULES}",
        output_config={"format": {"type": "json_schema", "schema": INVOICE_TOOL["input_schema"]}},
        messages=[{"role": "user", "content": document_message(doc(doc_id))}],
    )
    return Invoice.model_validate(json.loads(lab.text_of(response)))


def extract_strict_tool(client: Any, doc_id: str) -> tuple[Invoice, int, list[dict[str, Any]]]:
    """auto + strict tool + named in the prompt, then VERIFY and re-prompt if needed."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": document_message(doc(doc_id))}]
    for attempt in range(1, MAX_REPROMPTS + 2):
        response = client.messages.create(
            model=lab.MODEL,
            max_tokens=4000,
            system=SYSTEM_WITH_RULES + "\nAlways respond by calling extract_invoice.",
            tools=[INVOICE_TOOL],  # strict: True -> arguments always match the schema
            tool_choice={"type": "auto"},
            messages=messages,
        )
        block = first_tool_use(response)
        if block is not None:
            return Invoice.model_validate(block.input), attempt, messages
        print(f"    attempt {attempt}: text instead of a tool call -> {lab.text_of(response)[:70]!r}")
        messages += [
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": "Call extract_invoice now with the fields from the document. Do not answer in text."},
        ]
    raise RuntimeError(f"{doc_id}: no tool call after {MAX_REPROMPTS} re-prompt(s); route to manual review")


def main() -> None:
    lab.banner("D4.3  Structured outputs and strict tools on lab.MODEL")
    client = lab.get_client(scripted_extractor)

    lab.section('1. output_config.format {"type": "json_schema"}')
    structured = {}
    for doc_id in ("inv-001", "inv-002"):
        structured[doc_id] = inv = extract_structured_output(client, doc_id)
        print(f"  {doc_id}: vendor={inv.vendor_name!r} date={inv.invoice_date!r} po={inv.po_number!r} total={inv.total}")
    lab.check(len(structured) == 2, "the text block parsed with json.loads + pydantic for every document, no tool_choice involved")
    if not lab.is_live():
        lab.check(structured["inv-002"].po_number is None, "the same nullable schema works as an output_config format")

    lab.section("2. strict tool + auto + verify / re-prompt")
    attempts = {}
    history: dict[str, list[dict[str, Any]]] = {}
    for doc_id in ("inv-001", "inv-006"):
        inv, attempts[doc_id], history[doc_id] = extract_strict_tool(client, doc_id)
        print(f"  {doc_id}: tool_use on attempt {attempts[doc_id]} -> vendor={inv.vendor_name!r} total={inv.total}")

    if not lab.is_live():
        lab.check(attempts["inv-001"] == 1, "inv-001: the prompt named the tool and the model called it")
        lab.check(attempts["inv-006"] == 2, "inv-006: under auto the model answered the vendor's question; the verify step caught it")
        reprompt = history["inv-006"][-1]
        lab.check(
            reprompt["role"] == "user" and "extract_invoice" in reprompt["content"] and history["inv-006"][-2]["role"] == "assistant",
            "the re-prompt kept the text turn in history and named the tool explicitly",
        )


if __name__ == "__main__":
    main()
