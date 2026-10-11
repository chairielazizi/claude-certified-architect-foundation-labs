"""D5.2 - Multiple customer matches: ask for another identifier, never guess.

lookup_customer(name="John Smith") returns three accounts. The criteria prompt tells the
agent to ask for an email or postal code before touching any account. The vague prompt
lets it pick by heuristic ("the most recently active account is probably them"), which
here discloses a different customer's order.

Run:  python multiple_matches.py          (offline)
      python multiple_matches.py --live   (real API)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_agent import BASELINE_PROMPT, CRITERIA_PROMPT, execute_tool, run_conversation, scripted_model  # noqa: E402

TURNS = ["Hi, I'm John Smith. Has my latest order shipped?", "Sure, it's jsmith88@mail.com."]
ACTUAL_ORDER = "ORD-7020"  # the caller is C-2002 (Denver); the heuristic picks C-2003 (Boston)


def main() -> None:
    lab.banner("D5.2  Multiple matches: request an additional identifier")
    matches, _ = execute_tool("lookup_customer", {"name": "John Smith"})
    lab.show("lookup_customer(name='John Smith') returns", json.loads(matches))

    lab.section("Explicit criteria: ask, then look up by the unique identifier")
    good = run_conversation(lab.get_client(scripted_model), CRITERIA_PROMPT, TURNS)
    for text, reply in zip(TURNS, good["replies"]):
        print(f"  user: {text}\n  agent: {reply}")

    lab.section("Anti-pattern: pick one of the matches by heuristic")
    bad = run_conversation(lab.get_client(scripted_model), BASELINE_PROMPT, TURNS[:1])
    print(f"  user: {TURNS[0]}\n  agent: {bad['replies'][0]}")

    lab.section("Checks")
    if lab.is_live():
        print("  live run: behaviour above comes from the real model; offline checks skipped")
        return
    first = good["replies"][0]
    lab.check(
        good["turn_calls"][0] == ["lookup_customer"] and "email address or postal code" in first,
        "criteria: three matches -> the agent asked for an additional identifier",
    )
    lab.check("ORD-" not in first, "criteria: no account details were revealed while the match was ambiguous")
    lab.check(ACTUAL_ORDER in good["replies"][1], "criteria: the email gave a unique match and the right customer's order")
    lab.check(ACTUAL_ORDER not in bad["replies"][0] and "ORD-7031" in bad["replies"][0], "heuristic: picked the most recent account and disclosed someone else's order")


if __name__ == "__main__":
    main()
