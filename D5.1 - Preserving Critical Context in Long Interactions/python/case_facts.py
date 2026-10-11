"""D5.1 - Persistent case facts vs progressive summarization.

A long, multi-issue support session is compressed the usual way: once the verbatim
buffer is full, the oldest turns are folded into a running summary. It runs twice:

    A  naive       prompt = system + <conversation_summary> + recent turns
    B  case facts  prompt = system + <case_facts> + <open_issues> + <conversation_summary> + recent turns

Both runs use the SAME summarizer. The only difference is that B extracts transactional
facts from every turn before that turn can be summarized, and injects them into every
prompt outside the summarized history.

Run:  python case_facts.py          (offline, scripted summarizer + agent)
      python case_facts.py --live   (real API for both)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from context_layers import (  # noqa: E402
    BUFFER_LIMIT,
    SUMMARIZE_BATCH,
    CaseFacts,
    IssueLayer,
    build_system_prompt,
    extract_facts,
    load_fixture,
    scripted_model,
    summarize,
)

CRITICAL_FACTS = ["ORD-5521", "$89.90", "2026-10-02", "callback by Friday", "ORD-5590", "$24.50", "ORD-5602", "reversal_issued"]


def run_session(client: Any, conversation: dict[str, Any], with_case_facts: bool) -> dict[str, Any]:
    facts, issues = CaseFacts(), IssueLayer()
    summary = ""
    buffer: list[dict[str, str]] = []
    seen_text = ""
    # Per round: for each critical fact mentioned so far, is it still in the NEXT request?
    survival: list[dict[str, bool]] = []

    for turn in conversation["turns"]:
        if with_case_facts:
            extract_facts(turn, facts, issues)  # before the turn can ever reach the summarizer
        buffer.append(turn)
        seen_text += turn["text"] + "\n"
        if len(buffer) >= BUFFER_LIMIT:
            summary = summarize(client, summary, buffer[:SUMMARIZE_BATCH])
            buffer = buffer[SUMMARIZE_BATCH:]
            view = build_system_prompt(summary, facts if with_case_facts else None, issues if with_case_facts else None)
            view += "\n" + "\n".join(t["text"] for t in buffer)
            survival.append({fact: fact in view for fact in CRITICAL_FACTS if fact in seen_text})

    system = build_system_prompt(summary, facts if with_case_facts else None, issues if with_case_facts else None)
    messages: list[dict[str, Any]] = [{"role": t["role"], "content": t["text"]} for t in buffer]
    messages.append({"role": "user", "content": conversation["final_question"]})
    response = client.messages.create(model=lab.MODEL, max_tokens=16000, system=system, messages=messages)
    return {
        "summary": summary,
        "system": system,
        "survival": survival,
        "answer": lab.text_of(response),
        "facts": facts,
        "issues": issues,
    }


def main() -> None:
    lab.banner("D5.1  Case facts outside the summarized history")
    conversation = load_fixture("support_conversation.json")
    print(
        f"{len(conversation['turns'])} turns, 3 issues. Whenever {BUFFER_LIMIT} turns are unsummarized, "
        f"the oldest {SUMMARIZE_BATCH} are folded into the running summary."
    )

    runs: dict[str, dict[str, Any]] = {}
    for key, title, with_facts in [
        ("naive", "A - naive progressive summarization", False),
        ("facts", "B - same summarizer + case facts + issues layer", True),
    ]:
        lab.section(title)
        result = run_session(lab.get_client(scripted_model), conversation, with_facts)
        for i, row in enumerate(result["survival"], 1):
            lost = [f for f, ok in row.items() if not ok]
            print(
                f"  after round {i}: {len(row) - len(lost)}/{len(row)} critical facts mentioned so far are still in the prompt"
                + (f"; lost {lost}" if lost else "")
            )
        print(f"user: {conversation['final_question']}")
        print(f"assistant: {result['answer']}")
        runs[key] = result

    naive, withfacts = runs["naive"], runs["facts"]
    lab.section("What the final request contained")
    print(f"<conversation_summary> after {len(naive['survival'])} rounds (identical in A and B offline):\n  {withfacts['summary']}")
    print(withfacts["facts"].render())
    print(withfacts["issues"].render())

    lab.section("Checks")
    lab.check(len(withfacts["survival"]) == 4, "the session went through 4 rounds of progressive summarization")
    lab.check(
        len(withfacts["survival"][-1]) == len(CRITICAL_FACTS) and all(all(row.values()) for row in withfacts["survival"]),
        "B: every critical fact (amounts, dates, order IDs, statuses, the callback promise) survived every round",
    )
    statuses = [i["status"] for i in withfacts["issues"].issues]
    lab.check(
        statuses == ["refund_pending", "replacement_shipped", "reversal_issued"],
        "B: the issues layer has one row per issue, each with its LATEST status",
    )
    lab.check(
        "<case_facts>" in withfacts["system"] and "<case_facts>" not in withfacts["summary"],
        "B: the facts block is injected next to the summary, never inside it",
    )
    if not lab.is_live():
        lost = {f for f, ok in naive["survival"][-1].items() if not ok}
        lab.check(
            {"ORD-5521", "$89.90", "2026-10-02", "callback by Friday"} <= lost,
            "A: the first issue's order ID, amount, delivery date and the customer's deadline were summarized away",
        )
        lab.check(naive["summary"] == withfacts["summary"], "the summaries are identical: B did not need a better summarizer")
        needed = ["ORD-5521", "$89.90", "ORD-5590", "$24.50", "ORD-5602", "$129.00", "callback by Friday"]
        lab.check(all(x in withfacts["answer"] for x in needed), "B: the agent recapped all three issues and the promised callback")
        lab.check(
            "ORD-5521" not in naive["answer"] and "callback by Friday" not in naive["answer"],
            "A: the agent could not recap the first issue or the promise it made",
        )


if __name__ == "__main__":
    main()
