"""D1.4 - Structured handoff when escalating mid-process to a human agent.

A $899 refund is above the agent's $500 limit, so the gate blocks process_refund with a
structured error whose required_next_step is escalation. The model then calls escalate_to_human
with a HandoffSummary (customer_id, issue_summary, root_cause, refund_amount, actions_taken,
recommended_action, priority). The tool layer validates it, because the human picking up the
ticket has NO access to the transcript: the summary is all they get.

The anti-pattern ("customer upset about TV, see chat") is rejected with the list of what's missing.

Run:  python handoff.py          (offline)
      python handoff.py --live   (real API)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_tools import (  # noqa: E402
    AGENT_REFUND_LIMIT,
    HANDOFF_FIELDS,
    ORDERS,
    ToolLayer,
    make_support_model,
    render_ticket,
    run_agent,
    validate_handoff,
)

REQUEST = ("Hi, I'm Sam Rivera (sam@example.com). The TV from order ORD-2002 arrived with a cracked screen. "
           "I want a full refund of $899.00.")


def main() -> None:
    lab.banner("D1.4  Structured handoff to a human agent")

    lab.section("Escalation mid-process: refund above the agent limit")
    print(f"user: {REQUEST}")
    tools = ToolLayer(enforce=True)
    answer, _ = run_agent(lab.get_client(make_support_model()), REQUEST, tools)
    print(f"assistant: {answer}")
    sequence = [f"{c['tool']}:{c['outcome']}" for c in tools.calls]
    print(f"tool calls: {sequence}")

    lab.check(all(r["amount"] <= AGENT_REFUND_LIMIT for r in tools.refunds), f"no refund above ${AGENT_REFUND_LIMIT:.0f} ran without a human")
    lab.check(len(tools.escalations) >= 1, "the case was escalated to a human")
    ticket = tools.escalations[-1]  # the accepted one (an invalid handoff never creates a ticket)
    summary = ticket["summary"]

    lab.section("What the human agent sees (no transcript, only this ticket)")
    print(render_ticket(ticket["ticket_id"], summary))
    lab.check(validate_handoff(summary) == [], f"the handoff has every required field: {', '.join(HANDOFF_FIELDS)}")
    lab.check(tools.verified is not None and summary["customer_id"] == tools.verified["customer_id"],
              "customer_id is the VERIFIED id from get_customer, not a name")
    if not lab.is_live():
        lab.check(sequence == ["get_customer:ok", "lookup_order:ok", "process_refund:blocked", "escalate_to_human:ok"],
                  "verify -> look up -> refund blocked by the limit -> escalate")
        lab.check(summary["refund_amount"] == ORDERS["ORD-2002"]["total"], "refund_amount matches the looked-up order ($899.00)")
        lab.check(any("blocked" in a for a in summary["actions_taken"]), "actions_taken records the blocked refund, so the human won't retry it blindly")

    lab.section("Anti-pattern: a free-text handoff")
    bad = {"customer_id": "Sam Rivera", "issue_summary": "Customer is upset about a TV, see chat."}
    print(f"escalate_to_human({json.dumps(bad)})")
    content, is_error = ToolLayer(enforce=True).execute("escalate_to_human", bad)
    print(f"  -> is_error={is_error} {content}")
    problems = json.loads(content)["problems"]
    missing = [p.split(":")[0] for p in problems if p.endswith("missing")]
    lab.check(is_error and missing == ["root_cause", "refund_amount", "actions_taken", "recommended_action", "priority"],
              "rejected: no root cause, amount, actions, recommendation or priority for a human who can't read the chat")
    lab.check(any(p.startswith("customer_id: must be a verified id") for p in problems), "and a name is not a customer_id")


if __name__ == "__main__":
    main()
