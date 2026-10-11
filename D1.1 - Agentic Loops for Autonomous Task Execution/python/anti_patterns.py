"""D1.1 - Loop-termination anti-patterns the exam calls out, and how each one breaks.

Every broken loop below is run against the same scripted model as agentic_loop.py, so
the only variable is the control flow. This file always runs offline: two of the
anti-patterns would send malformed conversations to the real API.

Run:  python anti_patterns.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from agentic_loop import run_agent  # noqa: E402
from support_backend import SYSTEM_PROMPT, TOOLS, execute_tool, scripted_model  # noqa: E402

REQUEST = "Hi, I'm alice@example.com. Has my order arrived?"
CAP = 6


def call(client: Any, messages: list[dict[str, Any]]) -> Any:
    return client.messages.create(model=lab.MODEL, max_tokens=16000, system=SYSTEM_PROMPT, tools=TOOLS, messages=messages)


def run_tools(response: Any) -> dict[str, Any]:
    results = []
    for block in lab.tool_uses(response):
        content, _ = execute_tool(block.name, block.input)
        results.append({"type": "tool_result", "tool_use_id": block.id, "content": content})
    return {"role": "user", "content": results}


def anti_pattern_text_means_done(client: lab.ScriptedClient) -> str:
    """BAD: treats 'the response contains text' as completion."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": REQUEST}]
    while True:
        response = call(client, messages)
        if lab.text_of(response):  # <- wrong signal: text often accompanies tool_use
            return lab.text_of(response)
        messages += [{"role": "assistant", "content": response.content}, run_tools(response)]


def anti_pattern_iteration_cap(client: lab.ScriptedClient, max_iterations: int = 2) -> str:
    """BAD: an arbitrary iteration cap is the primary stopping mechanism."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": REQUEST}]
    last_text = ""
    for _ in range(max_iterations):  # <- stops on a count, not on what the model said
        response = call(client, messages)
        last_text = lab.text_of(response) or last_text
        messages += [{"role": "assistant", "content": response.content}, run_tools(response)]
    return last_text


def anti_pattern_parse_phrase(client: lab.ScriptedClient) -> str:
    """BAD: scans the reply for a natural-language 'I'm done' phrase."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": REQUEST}]
    for _ in range(CAP):
        response = call(client, messages)
        reply = lab.text_of(response)
        if "final answer" in reply.lower() or "i'm done" in reply.lower():  # <- brittle string match
            return reply
        messages.append({"role": "assistant", "content": response.content})
        if lab.tool_uses(response):
            messages.append(run_tools(response))
        # Without tool calls this re-sends a conversation that ends on an assistant turn,
        # which the real API rejects. It only "works" here because the model is scripted.
    return f"<gave up after {CAP} calls; last reply: {reply!r}>"


def anti_pattern_fixed_decision_tree(client: lab.ScriptedClient, request: str) -> str:
    """BAD (for open-ended tasks): a hard-coded tool sequence instead of model-driven choice."""
    del client  # the model never decides anything here
    email = next((w for w in request.split() if "@" in w), None)
    customer, is_error = execute_tool("get_customer", {"email": email or ""})  # always step 1
    if is_error:
        return f"<pipeline failed at step 1 get_customer: {customer}>"
    return "<would continue with lookup_order ...>"


def main() -> None:
    lab.banner("D1.1  Loop-termination anti-patterns (always offline)")
    print(f"user: {REQUEST}")

    lab.section("Correct: continue on tool_use, stop on end_turn")
    good_client = lab.ScriptedClient(scripted_model)
    good, _ = run_agent(good_client, REQUEST)
    print(f"answer: {good}")
    print(f"API calls: {len(good_client.messages.calls)}")

    lab.section("Anti-pattern 1: 'response has text' means done")
    c1 = lab.ScriptedClient(scripted_model)
    bad1 = anti_pattern_text_means_done(c1)
    print(f"answer: {bad1}")
    lab.check(bad1 != good and len(c1.messages.calls) == 1, "stopped on the first turn; no tool ever ran")

    lab.section("Anti-pattern 2: arbitrary iteration cap as the stop condition")
    c2 = lab.ScriptedClient(scripted_model)
    bad2 = anti_pattern_iteration_cap(c2)
    print(f"answer: {bad2}")
    lab.check(bad2 != good, "cap hit mid-task; the user gets a progress note instead of an answer")

    lab.section("Anti-pattern 3: parsing natural language for termination")
    c3 = lab.ScriptedClient(scripted_model)
    bad3 = anti_pattern_parse_phrase(c3)
    print(f"answer: {bad3}")
    lab.check(len(c3.messages.calls) == CAP, f"the model never said the magic phrase, so all {CAP} calls were spent")

    lab.section("Anti-pattern 4: pre-configured decision tree instead of model-driven choice")
    request_b = "Where is order ORD-5521?"
    print(f"user: {request_b}")
    bad4 = anti_pattern_fixed_decision_tree(lab.ScriptedClient(scripted_model), request_b)
    print(f"answer: {bad4}")
    good4, _ = run_agent(lab.ScriptedClient(scripted_model), request_b)
    print(f"model-driven loop instead: {good4}")
    lab.check(bad4.startswith("<pipeline failed") and "ORD-5521" in good4, "fixed sequence broke; the model adapted")


if __name__ == "__main__":
    main()
