"""D2.2 - What the model does with each error style (Claude loop over the MCP tools).

The MCP server's tools are offered to Claude with definitions taken from
``server.list_tools()``. Every tool_use is executed with ``server.call_tool`` and the
CallToolResult's ``isError`` becomes the tool_result's ``is_error``. The same customer
request runs against two servers:

  structured: business error + customerMessage -> explains the real reason, no retry
  generic:    "Operation failed"               -> can only retry blindly, then tells the
                                                   customer something vague (and wrong)

Run:  python agent_explains.py          (offline, scripted model turns)
      python agent_explains.py --live   (real Claude API, tools from the real MCP server)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from recovery_policy import result_text  # noqa: E402
from support_server import Backend, build_server  # noqa: E402

SYSTEM_PROMPT = (
    "You are a support agent for an electronics store. Use the tools for real data and actions. "
    "When a tool returns an error, decide from the error whether to retry, correct the input, "
    "escalate, or explain the outcome to the customer. Never invent policies or reasons."
)
REQUEST = "Hi, my 4K monitor from order ORD-1001 arrived with dead pixels. Please refund the $900 I paid."
SAFETY_MAX_ITERATIONS = 10


def scripted_support_model(params: dict[str, Any]) -> lab.Obj:
    """Offline stand-in: decides from the tool results in the conversation, like Claude would."""
    request = params["messages"][0]["content"]
    refund_calls = lab.all_tool_calls(params).count("process_refund")
    if refund_calls == 0:
        order_id = re.search(r"ORD-\d{4}", request)
        amount = re.search(r"\$(\d+(?:\.\d+)?)", request)
        return lab.message(
            lab.text("I'm sorry about the dead pixels - let me process that refund."),
            lab.tool_use("process_refund", {"order_id": order_id.group(0) if order_id else "", "amount": float(amount.group(1)) if amount else 0.0}),
        )

    last = lab.tool_results(params)[-1]
    if not last.get("is_error"):
        refund = json.loads(last["content"])
        return lab.message(lab.text(f"Done - refund {refund['refund_id']} for ${refund['amount']:.2f} has been issued."))

    try:
        body = json.loads(last["content"])
    except json.JSONDecodeError:
        body = {}
    category = body.get("errorCategory")
    if category == "business":
        # The envelope says: not retryable, and here is what to tell the customer.
        return lab.message(lab.text(f"I'm sorry about the monitor. {body['customerMessage']} Shall I go ahead?"))
    if category == "transient" and body.get("isRetryable") and refund_calls < 3:
        previous = [b for m in params["messages"] if m["role"] == "assistant" for b in m["content"] if b.get("type") == "tool_use"][-1]
        return lab.message(lab.text("A brief hiccup - retrying."), lab.tool_use("process_refund", dict(previous["input"])))
    if category in ("permission", "validation"):
        return lab.message(lab.text(f"I can't complete this myself ({body['message']}). I'm passing it to a colleague."))

    # Unstructured "Operation failed": no way to know whether a retry could help.
    if refund_calls < 3:
        previous = [b for m in params["messages"] if m["role"] == "assistant" for b in m["content"] if b.get("type") == "tool_use"][-1]
        return lab.message(lab.text("That didn't go through - let me try again."), lab.tool_use("process_refund", dict(previous["input"])))
    return lab.message(lab.text("I'm sorry, our refund system is having technical problems. Please try again later."))


async def claude_tools(server: Any) -> list[dict[str, Any]]:
    """MCP tool definitions -> Messages API tool definitions."""
    return [{"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in await server.list_tools()]


async def run_agent(client: Any, server: Any) -> tuple[str, list[dict[str, Any]]]:
    tools = await claude_tools(server)
    messages: list[dict[str, Any]] = [{"role": "user", "content": REQUEST}]
    for _ in range(SAFETY_MAX_ITERATIONS):
        response = client.messages.create(model=lab.MODEL, max_tokens=16000, system=SYSTEM_PROMPT, tools=tools, messages=messages)
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return lab.text_of(response), messages
        results = []
        for block in lab.tool_uses(response):
            result = await server.call_tool(block.name, dict(block.input))
            text = result_text(result)
            print(f"    {block.name}({dict(block.input)}) -> isError={result.is_error} {text[:90]}")
            # The MCP isError flag becomes the Messages API is_error flag.
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": text, "is_error": bool(result.is_error)})
        messages.append({"role": "user", "content": results})
    raise RuntimeError("agent did not finish")


def tool_calls(messages: list[dict[str, Any]], name: str) -> int:
    return sum(1 for m in messages if m["role"] == "assistant" for b in lab.tool_uses(lab.Obj(content=m["content"])) if b.name == name)


async def main() -> None:
    lab.banner("D2.2  How the model reacts to structured vs generic MCP errors")
    print(f"customer: {REQUEST}")
    outcomes: dict[str, tuple[str, list[dict[str, Any]]]] = {}
    for style in ("structured", "generic"):
        lab.section(f"{style} error responses")
        server = build_server(Backend(), style)
        answer, messages = await run_agent(lab.get_client(scripted_support_model), server)
        print(f"  agent -> customer: {answer}")
        outcomes[style] = (answer, messages)

    lab.section("Checks")
    lab.check(all(answer for answer, _ in outcomes.values()), "both runs ended with an answer for the customer (end_turn)")
    if not lab.is_live():
        s_answer, s_msgs = outcomes["structured"]
        g_answer, g_msgs = outcomes["generic"]
        first_result = next(b for m in s_msgs[1:] if m["role"] == "user" for b in m["content"])
        lab.check(
            first_result["is_error"] is True and json.loads(first_result["content"])["errorCategory"] == "business",
            "MCP isError reached the model as tool_result is_error=true, with the envelope as content",
        )
        lab.check(tool_calls(s_msgs, "process_refund") == 1 and "supervisor" in s_answer,
                  "structured: one call, customer hears the real reason (supervisor approval over $500)")
        lab.check(tool_calls(g_msgs, "process_refund") == 3, "generic: the model retried a policy refusal twice (wasted calls)")
        lab.check("technical" in g_answer and "500" not in g_answer, "generic: the customer is told a wrong reason ('technical problems')")


if __name__ == "__main__":
    lab.run(main())
