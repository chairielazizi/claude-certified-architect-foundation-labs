"""D4.3 - tool_choice: "auto" vs "any" vs forced {"type": "tool", "name": ...}.

    auto   -> the model MAY reply in text: no structured data is guaranteed
    any    -> the model MUST call a tool but picks which: right for an unknown document
              type with one extraction schema per type
    forced -> the model MUST call this tool: guarantees extract_metadata runs first,
              then the code routes to the enrichment tool in a follow-up turn

Live note: claude-opus-5-5 rejects "any"/forced with HTTP 400, so those calls use
lab.FORCED_TOOL_CHOICE_MODEL (claude-opus-5). See modern_structured_output.py for the
lab.MODEL alternatives.

Run:  python tool_choice_modes.py          (offline, scripted model)
      python tool_choice_modes.py --live   (real Claude API)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from extraction_tools import EXTRACTION_TOOLS, METADATA_TOOL, SYSTEM_WITH_RULES, doc, document_message, first_tool_use  # noqa: E402
from scripted_extractor import scripted_extractor  # noqa: E402

ROUTE = {"invoice": "extract_invoice", "receipt": "extract_receipt", "contract": "extract_contract"}


def call(client: Any, *, model: str, system: str, tools: list[dict[str, Any]], tool_choice: dict[str, Any], messages: list[dict[str, Any]]) -> Any:
    return client.messages.create(
        model=model, max_tokens=4000, system=system, tools=tools, tool_choice=tool_choice, messages=messages
    )


def main() -> None:
    lab.banner("D4.3  tool_choice auto / any / forced")
    client = lab.get_client(scripted_extractor)

    lab.section('A. tool_choice {"type": "auto"}: the model may just talk')
    response = call(
        client,
        model=lab.MODEL,
        system="You help the finance team with incoming business documents.",
        tools=EXTRACTION_TOOLS,
        tool_choice={"type": "auto"},
        messages=[{"role": "user", "content": document_message(doc("inv-001"))}],
    )
    print(f"  stop_reason={response.stop_reason}  text={lab.text_of(response)!r}")
    if not lab.is_live():
        lab.check(first_tool_use(response) is None, "auto: a text reply is a valid answer, so no structured data came back")

    lab.section('B. tool_choice {"type": "any"}: unknown document type, three schemas')
    picked = {}
    for doc_id in ("inv-001", "rcpt-001", "ctr-001"):
        response = call(
            client,
            model=lab.FORCED_TOOL_CHOICE_MODEL,  # "any" is a 400 on claude-opus-5-5
            system=SYSTEM_WITH_RULES,
            tools=EXTRACTION_TOOLS,
            tool_choice={"type": "any"},
            messages=[{"role": "user", "content": document_message(doc(doc_id))}],
        )
        block = first_tool_use(response)
        picked[doc_id] = block.name if block else None
        data = block.input if block else {}  # structured data = the tool_use block's input
        print(f"  {doc_id:<9} -> {picked[doc_id]:<17} {json.dumps(data)[:90]}...")
    lab.check(all(picked.values()), "any: every response carried a tool_use block")
    lab.check(
        picked == {"inv-001": "extract_invoice", "rcpt-001": "extract_receipt", "ctr-001": "extract_contract"},
        "any: the model chose the schema that matches each document",
    )

    lab.section('C. forced {"type": "tool", "name": "extract_metadata"}, then enrichment')
    tools = [METADATA_TOOL, *EXTRACTION_TOOLS]
    messages: list[dict[str, Any]] = [{"role": "user", "content": document_message(doc("ctr-001"))}]
    first = call(
        client,
        model=lab.FORCED_TOOL_CHOICE_MODEL,
        system=SYSTEM_WITH_RULES,
        tools=tools,
        tool_choice={"type": "tool", "name": "extract_metadata"},
        messages=messages,
    )
    meta_block = first_tool_use(first)
    metadata = meta_block.input
    lab.show("  turn 1 extract_metadata", metadata)

    # Follow-up turn: return the tool_result, then force the enrichment tool the CODE picked
    # from the metadata. The order is guaranteed by the request, not hoped for in a prompt.
    next_tool = ROUTE.get(metadata["doc_type"])
    messages += [
        {"role": "assistant", "content": first.content},
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": meta_block.id, "content": "metadata recorded"},
                {"type": "text", "text": "Now record the detailed fields."},
            ],
        },
    ]
    second = call(
        client,
        model=lab.FORCED_TOOL_CHOICE_MODEL,
        system=SYSTEM_WITH_RULES,
        tools=tools,
        tool_choice={"type": "tool", "name": next_tool or "extract_metadata"},
        messages=messages,
    )
    enrich_block = first_tool_use(second)
    lab.show(f"  turn 2 {enrich_block.name}", enrich_block.input)

    lab.check(meta_block.name == "extract_metadata", "forced: metadata extraction ran first although extract_contract was available")
    lab.check(next_tool == "extract_contract" and enrich_block.name == next_tool, "the follow-up turn ran the enrichment tool routed from the metadata")
    if not lab.is_live():
        lab.check(enrich_block.input["term_months"] == 24, "enrichment output is read straight from tool_use.input")


if __name__ == "__main__":
    main()
