"""D5.1 - The Messages API is stateless: send the complete history on every request.

The model knows only what is in the request. A chat loop must append every user and
assistant turn and re-send the whole list each time. The anti-pattern (send only the
newest message and assume the server remembers) breaks coherence on the next turn.

Run:  python stateless_history.py          (offline)
      python stateless_history.py --live   (real API)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

SYSTEM = "You are a concise customer support agent for an electronics store."
TURNS = [
    "My order ORD-5521 cost $89.90 and the headphones stopped working.",
    "I'd like a refund rather than a replacement.",
    "How much will I get back, and for which order?",
]


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    """Answers from whatever user turns are in THIS request; it has no other memory."""
    said = " ".join(m["content"] for m in params["messages"] if m["role"] == "user" and isinstance(m["content"], str))
    latest = lab.last_user_text(params).lower()
    order = re.search(r"ORD-\d{4}", said)
    amount = re.search(r"\$\d+\.\d{2}", said)
    if "how much" in latest:
        if order and amount:
            reply = f"You will get {amount.group(0)} back for {order.group(0)} once the refund is approved."
        else:
            reply = "Could you tell me which order this is about and how much you paid?"
    elif "refund" in latest:
        reply = f"No problem, I will start a refund for {order.group(0)}." if order else "Happy to help. Which order should I refund?"
    else:
        reply = f"Sorry to hear that. Would you like a refund or a replacement for {order.group(0)}?" if order else "How can I help?"
    return lab.message(lab.text(reply))


def chat(client: Any, send_full_history: bool) -> tuple[list[str], list[int], list[dict[str, Any]]]:
    history: list[dict[str, Any]] = []
    answers: list[str] = []
    sent_sizes: list[int] = []
    for text in TURNS:
        history.append({"role": "user", "content": text})
        # Copy the list: the request must be a snapshot, and the full list is the ONLY memory.
        request = list(history) if send_full_history else [history[-1]]
        sent_sizes.append(len(request))
        response = client.messages.create(model=lab.MODEL, max_tokens=16000, system=SYSTEM, messages=request)
        history.append({"role": "assistant", "content": response.content})  # keep the full turn
        answers.append(lab.text_of(response))
        print(f"  sent {len(request)} message(s) | user: {text}\n    assistant: {answers[-1]}")
    return answers, sent_sizes, history


def main() -> None:
    lab.banner("D5.1  Stateless API: pass the full conversation history every time")

    lab.section("Correct: re-send the whole history on every request")
    good, good_sizes, history = chat(lab.get_client(scripted_model), send_full_history=True)
    print(f"  roles in the last request: {[m['role'] for m in history[:-1]]}")

    lab.section("Anti-pattern: send only the newest message")
    bad, bad_sizes, _ = chat(lab.get_client(scripted_model), send_full_history=False)

    lab.section("Checks")
    lab.check(good_sizes == [1, 3, 5], "each request carried the complete history (1, 3, 5 messages)")
    lab.check(bad_sizes == [1, 1, 1], "the anti-pattern sent a single message each time")
    if not lab.is_live():
        lab.check("$89.90" in good[-1] and "ORD-5521" in good[-1], "with full history the model answered with the amount and order from turn 1")
        lab.check("$89.90" not in bad[-1], "without history the model had to ask again: the API remembers nothing")


if __name__ == "__main__":
    main()
