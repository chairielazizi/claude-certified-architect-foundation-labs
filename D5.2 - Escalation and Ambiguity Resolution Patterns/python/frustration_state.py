"""D5.2 - Explicit demand vs frustrated-but-solvable, tracked across turns.

Three conversations about the same dented kettle (a case the policy covers):

  A  "Transfer me to a human agent now."        -> escalate immediately, no lookup first
  B  frustrated + "maybe I should talk to a person", then the customer repeats it
                                                -> acknowledge + offer resolution, escalate on the repeat
  C  frustrated + the same hint, then accepts   -> acknowledge + offer, resolve, never escalate

The decision depends on conversation STATE (how many times a human was requested, whether
a resolution was already offered), derived from the full history on every turn.

Run:  python frustration_state.py          (offline)
      python frustration_state.py --live   (real API)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_agent import CRITERIA_PROMPT, conversation_state, run_conversation, scripted_model  # noqa: E402

HINT = "My kettle ORD-7005 arrived dented AGAIN!! Photo attached. Honestly, maybe I should just talk to a person."
SCENARIOS = {
    "A - explicit demand": ["Transfer me to a human agent now. My kettle order ORD-7005 is a mess."],
    "B - frustrated hint, then repeated": [HINT, "I appreciate it, but maybe I should still talk to a person."],
    "C - frustrated hint, then accepts": [HINT, "OK fine, please send the replacement."],
}


def main() -> None:
    lab.banner("D5.2  Frustration vs explicit requests: track conversation state")
    results = {}
    for title, turns in SCENARIOS.items():
        lab.section(title)
        result = run_conversation(lab.get_client(scripted_model), CRITERIA_PROMPT, turns, verbose=False)
        history: list[dict[str, str]] = []
        for i, (text, calls, reply) in enumerate(zip(turns, result["turn_calls"], result["replies"]), 1):
            history.append({"role": "user", "content": text})
            state = conversation_state({"messages": history})
            history.append({"role": "assistant", "content": reply})
            print(f"  turn {i} user: {text}")
            print(f"    state: human_mentions={state['human_mentions']} explicit_now={state['explicit_now']} frustrated={state['frustrated']}")
            print(f"    tools: {calls}\n    agent: {reply}")
        results[title[0]] = result

    a, b, c = results["A"], results["B"], results["C"]
    lab.section("Checks")
    if lab.is_live():
        print("  live run: behaviour above comes from the real model; offline checks skipped")
        return
    lab.check(a["calls"] == ["escalate_to_human"], "A: explicit demand escalated immediately, with no investigation first")
    lab.check(
        "escalate_to_human" not in b["turn_calls"][0] and "replacement" in b["replies"][0],
        "B turn 1: frustration plus a hint got an acknowledgement and an offer, not an escalation",
    )
    lab.check(b["turn_calls"][1] == ["escalate_to_human"], "B turn 2: the customer repeated the preference, so the agent escalated")
    lab.check(
        c["outcome"] == "resolve" and "escalate_to_human" not in c["calls"],
        "C: the customer accepted the offer; resolved on first contact, never escalated",
    )
    lab.check(c["replies"][0].startswith("I am sorry"), "the agent acknowledged the frustration before offering the fix")


if __name__ == "__main__":
    main()
