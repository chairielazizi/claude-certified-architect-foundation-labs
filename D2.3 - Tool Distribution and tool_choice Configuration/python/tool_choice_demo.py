"""D2.3 - tool_choice: "auto", "any", forced {"type": "tool"} and the modern alternative.

  1. Semantics on a conversational message:
       auto -> the model MAY answer in text     any  -> it MUST call some tool
       tool -> it MUST call the named tool      none -> it must not call tools
  2. Forced first step: {"type": "tool", "name": "extract_metadata"} on turn 1, then
     follow-up turns with "auto" for the enrichment tools. Compared with auto-only, where
     the model is free to start with an enrichment tool and skip the prerequisite.
  3. Modern alternative on lab.MODEL (which rejects forced choice with HTTP 400):
     auto + strict: true + an instruction naming the tool + VERIFY a tool_use came back,
     re-prompting if it did not.

Offline, a scripted model honors the tool_choice semantics exactly as the API defines them
and otherwise decides from the conversation. Live, forced ("any"/"tool") requests use
lab.FORCED_TOOL_CHOICE_MODEL because claude-opus-5-5 returns 400 for them.

Run:  python tool_choice_demo.py          (offline)
      python tool_choice_demo.py --live   (real Claude API)
"""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

SYSTEM_PROMPT = "You are the document-analysis agent in a research system. Work with documents by their id using the tools."

EXTRACT_METADATA = {
    "name": "extract_metadata",
    "description": (
        "Read a stored document by id and return {document_id, title, authors[], year, doi}. "
        "Run this before any enrichment tool: lookup_citations needs the DOI and "
        "lookup_author_affiliations needs the author list it returns."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"document_id": {"type": "string", "description": "Stored document id, for example doc-17"}},
        "required": ["document_id"],
        "additionalProperties": False,
    },
}
TOOLS: list[dict[str, Any]] = [
    EXTRACT_METADATA,
    {
        "name": "lookup_citations",
        "description": "Return {doi, citation_count} for a DOI such as 10.5555/abc.123. Needs a real DOI (from extract_metadata).",
        "input_schema": {"type": "object", "properties": {"doi": {"type": "string", "description": "DOI, 10.xxxx/..."}}, "required": ["doi"]},
    },
    {
        "name": "lookup_author_affiliations",
        "description": "Return {affiliations: {author: institution}} for a list of author names (from extract_metadata).",
        "input_schema": {
            "type": "object",
            "properties": {"authors": {"type": "array", "items": {"type": "string"}, "description": "Author names"}},
            "required": ["authors"],
        },
    },
]
# Modern alternative: strict: true guarantees schema-valid input for extract_metadata.
STRICT_TOOLS = [{**EXTRACT_METADATA, "strict": True}, *TOOLS[1:]]

DOCS = {
    "doc-17": {
        "document_id": "doc-17",
        "title": "Generative Models in Film Post-Production",
        "authors": ["R. Okafor", "L. Chen"],
        "year": 2025,
        "doi": "10.5555/film.2025.017",
    }
}
DOI = re.compile(r"^10\.\d{4,9}/\S+$")


def execute(name: str, args: dict[str, Any]) -> tuple[str, bool]:
    if name == "extract_metadata":
        doc = DOCS.get(str(args.get("document_id", "")))
        return (json.dumps(doc), False) if doc else (json.dumps({"errorCategory": "validation", "message": "unknown document_id"}), True)
    if name == "lookup_citations":
        doi = str(args.get("doi", ""))
        if not DOI.match(doi):
            return json.dumps({"errorCategory": "validation", "message": f"{doi!r} is not a DOI; get it from extract_metadata"}), True
        return json.dumps({"doi": doi, "citation_count": 42}), False
    if name == "lookup_author_affiliations":
        known = {"R. Okafor": "Lagos Institute of Media Arts", "L. Chen": "Vancouver Film School"}
        return json.dumps({"affiliations": {a: known.get(a, "unknown") for a in args.get("authors", [])}}), False
    return json.dumps({"error": f"unknown tool {name}"}), True


def build_request(
    tool_choice: dict[str, Any],
    messages: list[dict[str, Any]],
    *,
    system: str = SYSTEM_PROMPT,
    tools: list[dict[str, Any]] = TOOLS,
    model: str | None = None,
) -> dict[str, Any]:
    """Params for one turn. Forced choices go to a model that accepts them (see SDK notes)."""
    forced = tool_choice["type"] in ("any", "tool")
    return {
        "model": model or (lab.FORCED_TOOL_CHOICE_MODEL if forced else lab.MODEL),
        "max_tokens": 16000,
        "system": system,
        "tools": tools,
        "tool_choice": tool_choice,
        "messages": messages,
    }


# ---------------------------------------------------------------------------
# Offline model: honors tool_choice, otherwise decides from the conversation
# ---------------------------------------------------------------------------


def tool_history(params: dict[str, Any]) -> list[tuple[str, dict[str, Any], dict[str, Any], bool]]:
    """(tool name, input, parsed result, is_error) for every tool call answered so far."""
    calls: dict[str, tuple[str, dict[str, Any]]] = {}
    history = []
    for msg in params["messages"]:
        if isinstance(msg["content"], str):
            continue
        for block in msg["content"]:
            if block["type"] == "tool_use":
                calls[block["id"]] = (block["name"], block["input"])
            elif block["type"] == "tool_result" and block["tool_use_id"] in calls:
                name, args = calls[block["tool_use_id"]]
                history.append((name, args, json.loads(block["content"]), bool(block.get("is_error"))))
    return history


def wanted_action(params: dict[str, Any]) -> list[lab.Obj]:
    """What the model would do if left to choose (tool_choice auto)."""
    request = params["messages"][0]["content"]
    last_text = lab.last_user_text(params)
    history = tool_history(params)
    ok = {name: result for name, _, result, is_error in history if not is_error}
    failed = {name for name, _, _, is_error in history if is_error}
    doc = re.search(r"doc-\d+", request)
    doc_id = doc.group(0) if doc else ""

    if "call extract_metadata" in last_text.lower():  # an explicit re-prompt is obeyed
        return [lab.tool_use("extract_metadata", {"document_id": doc_id})]
    if "extract_metadata" in ok:
        meta = ok["extract_metadata"]
        if "lookup_citations" not in ok:
            return [
                lab.text("Metadata in hand; enriching it."),
                lab.tool_use("lookup_citations", {"doi": meta["doi"]}),
                lab.tool_use("lookup_author_affiliations", {"authors": meta["authors"]}),
            ]
        affiliations = ok.get("lookup_author_affiliations", {}).get("affiliations", {})
        return [lab.text(
            f"'{meta['title']}' ({meta['year']}, DOI {meta['doi']}) has {ok['lookup_citations']['citation_count']} "
            f"citations. Authors: {', '.join(f'{a} ({i})' for a, i in affiliations.items())}."
        )]
    if last_text.rstrip().endswith("?"):
        # A direct question tends to get a direct answer under auto, instructions or not.
        return [lab.text("I can read PDF, HTML and plain-text documents. Peer review status isn't something I can confirm from the id alone.")]
    if doc and re.search(r"citation|affiliation", request, re.I) and "lookup_citations" not in failed:
        # Free to choose, it jumps straight to the tool that matches the request's wording,
        # skipping the prerequisite step (it passes the document id where a DOI belongs).
        return [lab.tool_use("lookup_citations", {"doi": doc_id})]
    if doc:
        return [lab.tool_use("extract_metadata", {"document_id": doc_id})]
    return [lab.text("Which document should I look at?")]


def semantic_model(params: dict[str, Any]) -> lab.Obj:
    choice = params.get("tool_choice") or {"type": "auto"}
    blocks = wanted_action(params)
    uses = [b for b in blocks if b.type == "tool_use"]
    if choice["type"] == "none":
        return lab.message(*[b for b in blocks if b.type == "text"] or [lab.text("(answering without tools)")])
    if choice["type"] == "auto":
        return lab.message(*blocks)
    if choice["type"] == "any":
        # Must call SOME tool. Forced turns come back without a text preamble.
        return lab.message(*uses) if uses else lab.message(lab.tool_use(params["tools"][0]["name"], {"document_id": "unknown"}))
    # {"type": "tool", "name": X}: must call exactly that tool.
    name = choice["name"]
    match = next((b for b in uses if b.name == name), None)
    doc = re.search(r"doc-\d+", params["messages"][0]["content"])
    return lab.message(match or lab.tool_use(name, {"document_id": doc.group(0) if doc else "unknown"}))


# ---------------------------------------------------------------------------
# Loops
# ---------------------------------------------------------------------------


def run_loop(client: Any, request: str, first_choice: dict[str, Any], model: str | None = None) -> tuple[list[str], list[dict[str, Any]], str]:
    """First turn uses ``first_choice``; every follow-up turn uses auto."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": request}]
    choice = first_choice
    order: list[str] = []
    sent: list[dict[str, Any]] = []
    for _ in range(8):
        params = build_request(choice, messages, model=model)
        sent.append(copy.deepcopy({k: params[k] for k in ("model", "tool_choice")}))
        response = client.messages.create(**params)
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return order, sent, lab.text_of(response)
        results = []
        for block in lab.tool_uses(response):
            content, is_error = execute(block.name, dict(block.input))
            order.append(block.name + (" (error)" if is_error else ""))
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": content, **({"is_error": True} if is_error else {})})
        messages.append({"role": "user", "content": results})
        choice = {"type": "auto"}  # forced only where the guarantee is needed: the first step
    raise RuntimeError("loop did not finish")


def call_until_tool(client: Any, tool_name: str, request: str, max_attempts: int = 3) -> tuple[Any, int, list[dict[str, Any]]]:
    """Modern alternative to forcing: auto + strict tool + instruction, then VERIFY."""
    system = SYSTEM_PROMPT + f" Always begin by calling {tool_name} for the document, before answering anything else."
    messages: list[dict[str, Any]] = [{"role": "user", "content": request}]
    sent = []
    for attempt in range(1, max_attempts + 1):
        params = build_request({"type": "auto"}, messages, system=system, tools=STRICT_TOOLS)
        sent.append({"model": params["model"], "tool_choice": params["tool_choice"]})
        response = client.messages.create(**params)
        if any(b.name == tool_name for b in lab.tool_uses(response)):
            return response, attempt, sent
        # No tool call came back: keep the model's turn and ask again, explicitly.
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": f"Please call {tool_name} for that document now, as instructed."})
    raise RuntimeError(f"{tool_name} was not called after {max_attempts} attempts")


def describe(response: Any) -> str:
    kinds = [f"tool_use:{b.name}" if b.type == "tool_use" else b.type for b in response.content if b.type in ("text", "tool_use")]
    return f"stop_reason={response.stop_reason} content={kinds}"


def main() -> None:
    lab.banner("D2.3  tool_choice: auto, any, forced tool, and the modern alternative")
    client = lab.get_client(semantic_model)

    lab.section("1. Same conversational message, four tool_choice settings")
    chat = "Thanks! Quick question - which file formats can you read?"
    print(f"user: {chat}")
    seen: dict[str, Any] = {}
    for label, choice in (
        ("auto", {"type": "auto"}),
        ("any", {"type": "any"}),
        ("tool", {"type": "tool", "name": "extract_metadata"}),
        ("none", {"type": "none"}),
    ):
        params = build_request(choice, [{"role": "user", "content": chat}])
        response = client.messages.create(**params)
        seen[label] = (params["model"], response)
        print(f"  {json.dumps(choice):<48} model={params['model']:<16} {describe(response)}")

    lab.section("2a. auto on every turn")
    task = "Add citation counts and author affiliations for document doc-17."
    print(f"user: {task}")
    auto_order, _, auto_answer = run_loop(client, task, {"type": "auto"})
    print(f"  tool order: {auto_order}")

    lab.section("2b. forced extract_metadata first, then auto")
    forced_order, forced_sent, forced_answer = run_loop(
        client, task, {"type": "tool", "name": "extract_metadata"}, model=lab.FORCED_TOOL_CHOICE_MODEL
    )
    print(f"  tool order: {forced_order}")
    print(f"  tool_choice per turn: {[s['tool_choice']['type'] for s in forced_sent]}")
    print(f"  answer: {forced_answer}")

    lab.section(f"3. Modern alternative on {lab.MODEL}: auto + strict + instruction + verify")
    question = "Here's doc-17. Before anything else - is it peer-reviewed?"
    print(f"user: {question}")
    response, attempts, strict_sent = call_until_tool(client, "extract_metadata", question)
    print(f"  extract_metadata came back on attempt {attempts}: {describe(response)}")
    print(f"  requests: {strict_sent}")

    lab.section("Checks")
    any_model, any_resp = seen["any"]
    tool_model, tool_resp = seen["tool"]
    lab.check(any_model == lab.FORCED_TOOL_CHOICE_MODEL == tool_model, f"forced requests (any/tool) use {lab.FORCED_TOOL_CHOICE_MODEL}, not {lab.MODEL}")
    lab.check(bool(lab.tool_uses(any_resp)), "tool_choice any: the model called a tool instead of replying in text")
    lab.check([b.name for b in lab.tool_uses(tool_resp)] == ["extract_metadata"], "forced tool_choice: exactly the named tool was called")
    lab.check(not lab.tool_uses(seen["none"][1]), "tool_choice none: no tool call")
    lab.check(forced_order[0] == "extract_metadata", "forced first step guaranteed: extract_metadata ran before enrichment")
    lab.check(all(s["tool_choice"]["type"] == "auto" for s in forced_sent[1:]), "follow-up turns went back to auto")
    lab.check(all(s["model"] == lab.MODEL and s["tool_choice"]["type"] == "auto" for s in strict_sent), f"modern alternative stays on {lab.MODEL} with tool_choice auto")
    lab.check(STRICT_TOOLS[0].get("strict") is True and EXTRACT_METADATA["input_schema"]["additionalProperties"] is False, "strict tool: additionalProperties false + required fields")
    if not lab.is_live():
        lab.check(not lab.tool_uses(seen["auto"][1]), "tool_choice auto: the model chose to answer in text")
        lab.check(auto_order[0].startswith("lookup_citations (error)"), "auto-only: model skipped extract_metadata and wasted a call on a bad DOI")
        lab.check("42 citations" in forced_answer and "(error)" not in " ".join(forced_order), "forced pipeline enriched with the real DOI and authors, no errors")
        lab.check(attempts == 2, "verify step caught a text-only reply and the re-prompt produced the tool call")


if __name__ == "__main__":
    main()
