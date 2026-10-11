"""D5.1 - Trim verbose tool output before it accumulates in context.

lookup_order returns 47 fields; a returns conversation needs 5 of them. Every tool result
stays in the history and is re-sent with every later request, so the waste compounds
over a session. The fix lives in the tool executor: keep only the relevant fields BEFORE
the result is appended to the conversation.

(In the Agent SDK the same trim can be done in a PostToolUse hook that returns
``updatedToolOutput``; see D1.5.)

Run:  python tool_output_trimming.py          (offline)
      python tool_output_trimming.py --live   (real API)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from context_layers import load_fixture  # noqa: E402

ORDERS = load_fixture("order_lookup.json")
RETURN_FIELDS = ["order_id", "item_names", "total", "delivered_on", "return_window_ends"]
TODAY = "2026-10-11"

SYSTEM = (
    "You are a returns assistant for an electronics store. Today is 2026-10-11. Call lookup_order "
    "for every order the customer asks about. An order can be returned on or before its "
    "return_window_ends date. Answer in one sentence per order."
)
TOOLS: list[dict[str, Any]] = [
    {
        "name": "lookup_order",
        "description": "Fetch one order by its ID (format ORD-####). Returns the order record, including items, total, delivery date and return window end date.",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string", "description": "Order ID, e.g. ORD-5521"}},
            "required": ["order_id"],
        },
    }
]
TURNS = [
    "I'd like to return the headphones from ORD-5521.",
    "What about ORD-5590?",
    "And ORD-5602?",
    "Finally, can I still return ORD-5477?",
]


def compact_json(value: Any) -> str:
    # Same bytes as JSON.stringify in the TypeScript version, so both report identical sizes.
    return json.dumps(value, separators=(",", ":"))


def full_record(order_id: str) -> dict[str, Any]:
    return {**ORDERS["template"], **ORDERS["orders"][order_id]}


def trim_for_returns(record: dict[str, Any]) -> dict[str, Any]:
    return {field: record[field] for field in RETURN_FIELDS}


def execute_lookup(order_id: str, trim: bool) -> tuple[str, bool]:
    if order_id not in ORDERS["orders"]:
        return compact_json({"error": f"No order {order_id}"}), True
    record = full_record(order_id)
    return compact_json(trim_for_returns(record) if trim else record), False


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    results = lab.tool_results(params)
    if results:
        order = json.loads(results[-1]["content"])
        window = order["return_window_ends"]
        head = f"{order['order_id']} ({', '.join(order['item_names'])}, ${order['total']})"
        if TODAY <= window:  # ISO dates compare correctly as strings
            return lab.message(lab.text(f"{head} can be returned until {window}."))
        return lab.message(lab.text(f"{head} is past its return window, which ended on {window}."))
    order_id = re.search(r"ORD-\d{4}", lab.last_user_text(params))
    if order_id:
        return lab.message(lab.tool_use("lookup_order", {"order_id": order_id.group(0)}))
    return lab.message(lab.text("Which order would you like to return?"))


def tool_output_chars(messages: list[dict[str, Any]]) -> int:
    total = 0
    for msg in messages:
        if msg["role"] == "user" and not isinstance(msg["content"], str):
            total += sum(len(b["content"]) for b in msg["content"] if b.get("type") == "tool_result")
    return total


def run_session(client: Any, trim: bool) -> dict[str, Any]:
    messages: list[dict[str, Any]] = []
    answers: list[str] = []
    resent: list[int] = []  # tool-output chars carried by each request
    for text in TURNS:
        messages.append({"role": "user", "content": text})
        while True:
            resent.append(tool_output_chars(messages))
            response = client.messages.create(
                model=lab.MODEL, max_tokens=16000, system=SYSTEM, tools=TOOLS, messages=list(messages)
            )
            messages.append({"role": "assistant", "content": response.content})
            if response.stop_reason != "tool_use":  # loop control simplified; D1.1 covers every stop_reason
                break
            results = []
            for block in lab.tool_uses(response):
                content, is_error = execute_lookup(block.input.get("order_id", ""), trim)
                result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
                if is_error:
                    result["is_error"] = True
                results.append(result)
            messages.append({"role": "user", "content": results})
        answers.append(lab.text_of(response))
    return {"answers": answers, "history_chars": tool_output_chars(messages), "resent_chars": sum(resent), "requests": len(resent)}


def main() -> None:
    lab.banner("D5.1  Trim verbose tool output before it accumulates")
    record = full_record("ORD-5521")
    trimmed = trim_for_returns(record)
    print(f"lookup_order returns {len(record)} fields ({len(compact_json(record))} chars); returns need {len(trimmed)}:")
    print(f"  {compact_json(trimmed)}")

    runs: dict[str, dict[str, Any]] = {}
    for key, title, trim in [("full", "A - append the full 47-field record", False), ("trim", "B - trim to return-relevant fields first", True)]:
        lab.section(title)
        runs[key] = run_session(lab.get_client(scripted_model), trim)
        for question, answer in zip(TURNS, runs[key]["answers"]):
            print(f"  user: {question}\n    assistant: {answer}")

    full, trim = runs["full"], runs["trim"]
    lab.section("Context cost over the session")
    rows = [
        ("fields kept per lookup", len(record), len(trimmed)),
        ("tool-output chars in final history", full["history_chars"], trim["history_chars"]),
        (f"tool-output chars re-sent over {full['requests']} requests", full["resent_chars"], trim["resent_chars"]),
        ("~tokens re-sent (chars / 4)", (full["resent_chars"] + 3) // 4, (trim["resent_chars"] + 3) // 4),
    ]
    print(f"  {'':44}{'full':>10}{'trimmed':>10}")
    for label, a, b in rows:
        print(f"  {label:44}{a:>10,}{b:>10,}")
    saved = 100 - (trim["resent_chars"] * 100) // full["resent_chars"]
    print(f"  saved: {saved}% of the tool-output context")

    lab.section("Checks")
    lab.check(len(record) >= 40 and len(trimmed) == 5, "the raw lookup has 40+ fields; the trimmed one keeps 5")
    lab.check(trim["history_chars"] * 5 <= full["history_chars"], "trimmed results take at most 20% of the space in the history")
    lab.check(saved >= 80, "over the session, trimming saved at least 80% of the re-sent tool output")
    if not lab.is_live():
        lab.check(full["answers"] == trim["answers"], "answers are identical: the 5 fields carried everything the task needed")
        lab.check("past its return window" in trim["answers"][-1], "the return-window logic still works on the trimmed record")


if __name__ == "__main__":
    main()
