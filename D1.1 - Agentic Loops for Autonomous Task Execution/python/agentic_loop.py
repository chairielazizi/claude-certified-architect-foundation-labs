"""D1.1 - A correct agentic loop, driven by stop_reason.

    request -> inspect stop_reason
        "tool_use" -> run every requested tool -> append results -> request again
        "end_turn" -> done: present the final answer

Run:  python agentic_loop.py          (offline, scripted model turns)
      python agentic_loop.py --live   (real Claude API)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_backend import SYSTEM_PROMPT, TOOLS, execute_tool, scripted_model  # noqa: E402

# A runaway guard, NOT the stopping mechanism. Hitting it is a bug to investigate,
# so it raises instead of quietly returning a half-finished answer.
SAFETY_MAX_ITERATIONS = 25


def run_agent(client: Any, user_request: str) -> tuple[str, list[dict[str, Any]]]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": user_request}]

    for iteration in range(1, SAFETY_MAX_ITERATIONS + 1):
        response = client.messages.create(
            model=lab.MODEL,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )
        print(f"  iteration {iteration}: stop_reason={response.stop_reason!r}")

        # Append the FULL assistant content (text, tool_use and any thinking blocks) so the
        # next request carries the model's own prior reasoning and tool calls.
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in lab.tool_uses(response):
                content, is_error = execute_tool(block.name, block.input)
                print(f"    ran {block.name}({block.input}) -> {content}")
                result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
                if is_error:
                    result["is_error"] = True  # let the model see and reason about failures
                tool_results.append(result)
            # Every result for this turn goes back in ONE user message, matched by tool_use_id.
            messages.append({"role": "user", "content": tool_results})
            continue

        if response.stop_reason == "end_turn":
            return lab.text_of(response), messages

        if response.stop_reason == "pause_turn":
            # A server-side tool paused a long turn; re-send so the model can resume it.
            continue

        if response.stop_reason == "max_tokens":
            raise RuntimeError("Response truncated at max_tokens; raise max_tokens and retry")

        if response.stop_reason == "refusal":
            return "The request was declined.", messages

        raise RuntimeError(f"Unexpected stop_reason {response.stop_reason!r}")

    raise RuntimeError(f"Loop did not converge in {SAFETY_MAX_ITERATIONS} iterations")


def main() -> None:
    lab.banner("D1.1  Agentic loop controlled by stop_reason")

    scenarios = {
        "A - customer identifies by email": "Hi, I'm alice@example.com. Has my order arrived?",
        "B - customer gives the order ID": "Where is order ORD-5521?",
    }
    for title, request in scenarios.items():
        lab.section(title)
        print(f"user: {request}")
        client = lab.get_client(scripted_model)
        answer, history = run_agent(client, request)
        print(f"assistant: {answer}")

        tool_turns = [m for m in history if m["role"] == "assistant" and lab.tool_uses(lab.Obj(content=m["content"]))]
        result_turns = [m for m in history[1:] if m["role"] == "user"]
        tools_called = [b.name for m in tool_turns for b in lab.tool_uses(lab.Obj(content=m["content"]))]
        print(f"  tools the model chose, in order: {tools_called}")

        lab.check(history[-1]["role"] == "assistant", "loop ended on the end_turn assistant message")
        lab.check(len(result_turns) == len(tool_turns), "each tool_use turn was answered by one user turn of tool_results")
        failed = [b for m in result_turns for b in m["content"] if b.get("is_error")]
        lab.check(not failed, "every tool call succeeded")
        if not lab.is_live() and title.startswith("B"):
            lab.check(tools_called == ["lookup_order"], "model skipped get_customer because the order ID was given")


if __name__ == "__main__":
    main()
