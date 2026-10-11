"""D2.1 - Tool-selection reliability harness: same requests, two toolsets, measured accuracy.

Each request is sent with tool_choice {"type": "auto"} and we record which tool the
model picks first. Three runs:

  A  BAD_TOOLS  + reviewed system prompt   (minimal / overlapping descriptions)
  B  GOOD_TOOLS + reviewed system prompt   (expanded, differentiated descriptions)
  C  GOOD_TOOLS + keyword-trap prompt      (good descriptions overridden by prompt wording)

Offline, a "description-sensitive" stand-in model chooses: it scores each tool by how
much of the request its name + description + parameter docs support (boundary
sentences such as "Does not ... use X instead" count AGAINST the tool), and when the
top candidates are too close to call it guesses the first-listed one. Claude is not a
keyword matcher, but this reproduces the mechanism the exam describes: the
description is the main evidence for selection, so thin evidence -> unreliable picks.

Run:  python selection_harness.py          (offline stand-in model)
      python selection_harness.py --live   (real Claude API, tool_choice auto)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from tool_lint import keyword_rules, lint_system_prompt, score_tools, stem, tokens  # noqa: E402
from toolsets import (  # noqa: E402
    BAD_TOOLS,
    GOOD_TOOLS,
    KEYWORD_TRAP_SYSTEM_PROMPT,
    RENAMES,
    REQUESTS,
    REVIEWED_SYSTEM_PROMPT,
)

# The best tool must lead the runner-up by at least this much evidence; otherwise the
# stand-in "can't tell them apart" and takes the first-listed candidate.
MARGIN = 2


def description_sensitive_model(params: dict[str, Any]) -> lab.Obj:
    """Offline stand-in for Claude choosing a tool under tool_choice auto."""
    tools = params["tools"]
    names = [t["name"] for t in tools]
    request = lab.last_user_text(params)
    by_name = {t["name"]: t for t in tools}

    def call(name: str) -> lab.Obj:
        schema = by_name[name]["input_schema"]
        fields = schema.get("required") or list(schema.get("properties", {}))[:1]
        return lab.message(lab.tool_use(name, {field: request for field in fields}))

    # 1. Prompt instructions are strong signals. A keyword-triggered rule fires on the
    #    keyword alone - exactly the unintended association the prompt linter flags.
    for keyword, tool in keyword_rules(lab.system_text(params)):
        if stem(keyword) in tokens(request) and tool in names:
            return call(tool)

    # 2. Otherwise choose on description evidence. No tool has any -> answer in text
    #    (tool_choice auto allows that). Several within MARGIN of the best -> the
    #    descriptions do not separate them, so the pick is a guess: first-listed.
    scored = score_tools(tools, request)
    best = max(score for _, score in scored)
    if best <= 0:
        return lab.message(lab.text("I'm not sure which tool handles that - could you clarify?"))
    near_tied = [name for name, score in scored if score > 0 and score > best - MARGIN]
    return call(near_tied[0])


def pick_tool(client: Any, tools: list[dict[str, Any]], system: str, request: str) -> str | None:
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=4000,  # one tool choice per request; thinking still needs some room
        system=system,
        tools=tools,
        tool_choice={"type": "auto"},
        messages=[{"role": "user", "content": request}],
    )
    uses = lab.tool_uses(response)
    return uses[0].name if uses else None  # None = answered in text instead


def evaluate(label: str, tools: list[dict[str, Any]], system: str) -> tuple[float, dict[str, str | None]]:
    lab.section(label)
    client = lab.get_client(description_sensitive_model)
    names = {t["name"] for t in tools}
    picks: dict[str, str | None] = {}
    correct = 0
    for request, expected_good in REQUESTS:
        # Map the expected answer onto this toolset (split tools collapse to analyze_document).
        expected = expected_good if expected_good in names else RENAMES[expected_good]
        chosen = pick_tool(client, tools, system, request)
        picks[request] = chosen
        ok = chosen == expected
        correct += ok
        print(f"  {'ok  ' if ok else 'MISS'} {request[:58]:<58} -> {chosen or '(text answer)'}  (expected {expected})")
    accuracy = correct / len(REQUESTS)
    print(f"  accuracy: {correct}/{len(REQUESTS)} = {accuracy:.0%}")
    return accuracy, picks


def main() -> None:
    lab.banner("D2.1  Tool selection reliability: minimal vs differentiated descriptions")

    lab.section("Why sample question 2 misroutes: evidence per tool for 'check my order #12345'")
    q2 = REQUESTS[0][0]
    print(f"  request tokens: {sorted(tokens(q2))}")
    for label, tools in (("BAD ", BAD_TOOLS), ("GOOD", GOOD_TOOLS)):
        print(f"  {label}: {score_tools(tools, q2)}")
    print(f"  BAD : both tools take an untyped 'Identifier'; lookup_order leads by 1 (< margin {MARGIN})")
    print("        -> the descriptions do not separate them -> guess: first-listed get_customer")
    print("  GOOD: '#12345' matches lookup_order's documented input format, and get_customer's")
    print("        boundary sentence ('send it to lookup_order instead') counts against it")

    acc_bad, picks_bad = evaluate("A - BAD_TOOLS, reviewed prompt", BAD_TOOLS, REVIEWED_SYSTEM_PROMPT)
    acc_good, picks_good = evaluate("B - GOOD_TOOLS, reviewed prompt", GOOD_TOOLS, REVIEWED_SYSTEM_PROMPT)
    acc_trap, picks_trap = evaluate("C - GOOD_TOOLS, keyword-trap prompt", GOOD_TOOLS, KEYWORD_TRAP_SYSTEM_PROMPT)

    lab.section("Prompt review")
    for finding in lint_system_prompt(KEYWORD_TRAP_SYSTEM_PROMPT, [t["name"] for t in GOOD_TOOLS]):
        print(f"  - {finding}")

    lab.section("Checks")
    names_good = [t["name"] for t in GOOD_TOOLS]
    lab.check(bool(lint_system_prompt(KEYWORD_TRAP_SYSTEM_PROMPT, names_good)), "prompt linter flags the keyword-trigger instructions")
    lab.check(not lint_system_prompt(REVIEWED_SYSTEM_PROMPT, names_good), "reviewed prompt (rule stated by intent) has no keyword triggers")
    if not lab.is_live():
        lab.check(acc_good > acc_bad, f"expanded descriptions route better ({acc_good:.0%} vs {acc_bad:.0%})")
        lab.check(acc_good == 1.0, "every ambiguous request reaches the intended tool with GOOD_TOOLS")
        lab.check(picks_bad[q2] == "get_customer", "sample Q2 reproduced: minimal descriptions send 'check my order' to get_customer")
        lab.check(picks_good[q2] == "lookup_order", "same request routes to lookup_order once descriptions are expanded")
        lab.check(
            picks_trap[q2] == "get_customer" and acc_trap < acc_good,
            "keyword-sensitive prompt wording overrides good descriptions (unintended association)",
        )
    else:
        print(f"  live accuracy: bad={acc_bad:.0%} good={acc_good:.0%} keyword-trap={acc_trap:.0%} (varies run to run)")


if __name__ == "__main__":
    main()
