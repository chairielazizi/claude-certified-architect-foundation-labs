"""Context layers for a long support session (shared by the D5.1 demos).

Every request in the case-facts pipeline is assembled from three layers:

    system prompt
      + <case_facts>      amounts, dates, order IDs, customer expectations  (extracted, never summarized)
      + <open_issues>     one row per issue: id, order, amount, status      (separate layer, multi-issue)
      + <conversation_summary>                                          (lossy, re-summarized each round)
    messages = the most recent turns verbatim + the new user message

The scripted models are "model-driven" in the way that matters here: the summarizer
compresses whatever text it is given (keeping the gist and dropping specifics, the
documented failure mode), and the support agent can only repeat facts that are actually
visible in its prompt. In live mode the same code calls the real API.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


AGENT_SYSTEM_PROMPT = (
    "You are a customer support agent for an online electronics store. "
    "The <case_facts> and <open_issues> blocks, when present, are authoritative and current; "
    "prefer them over the conversation summary. Quote exact amounts, dates and order IDs."
)
SUMMARIZER_PROMPT = "Summarize this customer support conversation in a few short sentences."

# Summarize the oldest SUMMARIZE_BATCH turns once the verbatim buffer reaches this size.
BUFFER_LIMIT = 6
SUMMARIZE_BATCH = 4

ORDER_RE = re.compile(r"ORD-\d{4}")
AMOUNT_RE = re.compile(r"\$\d+\.\d{2}")
DATED_EVENT_RE = re.compile(r"\b(paid|delivered|charged)\b[^\n]*? on (\d{4}-\d{2}-\d{2})")
STATUS_RE = re.compile(r"status: ([a-z_]+)")
EXPECTATION_RE = re.compile(r"\bI expect ([^.]+)\.")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
DATE_LABELS = {"paid": "purchased_on", "delivered": "delivered_on", "charged": "charged_on"}


# ---------------------------------------------------------------------------
# The persistent layers: case facts + issues
# ---------------------------------------------------------------------------


class CaseFacts:
    """Transactional facts and customer-stated expectations, kept verbatim."""

    def __init__(self) -> None:
        self.customer: str | None = None
        self.orders: dict[str, dict[str, str]] = {}
        self.expectations: list[str] = []

    def render(self) -> str:
        lines = ["<case_facts>", f"customer: {self.customer or 'unknown'}", "orders:"]
        for order_id, facts in self.orders.items():
            lines.append(f"  {order_id}: " + "; ".join(f"{k} {v}" for k, v in facts.items()))
        lines.append("customer_expectations:")
        lines += [f'  - "{e}"' for e in self.expectations] or ["  - none stated"]
        lines.append("</case_facts>")
        return "\n".join(lines)


class IssueLayer:
    """One structured row per issue so a multi-issue session never blends issues together."""

    def __init__(self) -> None:
        self.issues: list[dict[str, str]] = []

    def for_order(self, order_id: str) -> dict[str, str]:
        for issue in self.issues:
            if issue["order_id"] == order_id:
                return issue
        issue = {"issue_id": f"ISS-{len(self.issues) + 1}", "order_id": order_id, "amount": "unknown", "status": "open"}
        self.issues.append(issue)
        return issue

    def render(self) -> str:
        lines = ["<open_issues>", "| issue | order | amount | status |", "|---|---|---|---|"]
        lines += [f"| {i['issue_id']} | {i['order_id']} | {i['amount']} | {i['status']} |" for i in self.issues]
        lines.append("</open_issues>")
        return "\n".join(lines)


def extract_facts(turn: dict[str, str], facts: CaseFacts, issues: IssueLayer) -> None:
    """Pull facts out of a turn BEFORE it can ever be summarized.

    Deterministic regexes stand in for the production approach (read transactional facts
    straight from tool results, and use a structured-output extraction call for what the
    customer says). The point of the lab is where the facts live, not how they are parsed.
    """
    text = turn["text"]
    email = EMAIL_RE.search(text)
    if email and facts.customer is None:
        facts.customer = email.group(0)
    order = ORDER_RE.search(text)  # each turn in the fixture is about at most one order
    if order:
        order_id = order.group(0)
        order_facts = facts.orders.setdefault(order_id, {})
        amount = AMOUNT_RE.search(text)
        if amount and "amount" not in order_facts:
            order_facts["amount"] = amount.group(0)
        for event in DATED_EVENT_RE.finditer(text):
            order_facts.setdefault(DATE_LABELS[event.group(1)], event.group(2))
        issue = issues.for_order(order_id)
        if "amount" in order_facts:
            issue["amount"] = order_facts["amount"]
        status = STATUS_RE.search(text)
        if status:
            issue["status"] = status.group(1)  # latest status wins: the layer is always current
    if turn["role"] == "user":
        for expectation in EXPECTATION_RE.finditer(text):
            if expectation.group(1) not in facts.expectations:
                facts.expectations.append(expectation.group(1))


def build_system_prompt(summary: str, facts: CaseFacts | None, issues: IssueLayer | None) -> str:
    parts = [AGENT_SYSTEM_PROMPT]
    if facts is not None and issues is not None:
        parts += [facts.render(), issues.render()]  # OUTSIDE the summarized history
    parts.append(f"<conversation_summary>\n{summary or '(nothing summarized yet)'}\n</conversation_summary>")
    return "\n\n".join(parts)


def summarize(client: Any, previous_summary: str, turns: list[dict[str, str]]) -> str:
    """One round of progressive summarization: (previous summary + oldest turns) -> new summary."""
    transcript = "\n".join(f"{t['role']}: {t['text']}" for t in turns)
    prompt = (
        f"Previous summary:\n{previous_summary or '(none)'}\n\n"
        f"New turns:\n{transcript}\n\nWrite the updated summary."
    )
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=SUMMARIZER_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    return lab.text_of(response).strip()


def visible_text(params: dict[str, Any]) -> str:
    """Everything the model can see in a request: system prompt plus every message's text."""
    parts = [lab.system_text(params)]
    for msg in params.get("messages", []):
        content = msg["content"]
        if isinstance(content, str):
            parts.append(content)
        else:
            parts += [b.get("text", "") if isinstance(b, dict) else getattr(b, "text", "") for b in content]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Offline stand-ins for Claude
# ---------------------------------------------------------------------------

# New turns lose dates and deadlines; re-summarizing an old summary also loses amounts,
# order IDs and statuses. That is "progressive" loss: each round is a little vaguer.
LIGHT_VAGUE = [
    (re.compile(r" on \d{4}-\d{2}-\d{2}"), " recently"),
    (re.compile(r"\d{4}-\d{2}-\d{2}"), "recently"),
    (re.compile(r"by (?:Monday|Tuesday|Wednesday|Thursday|Friday)"), "soon"),
]
HEAVY_VAGUE = LIGHT_VAGUE + [
    (EMAIL_RE, "the customer"),
    (re.compile(r"\$\d+(?:\.\d{2})?"), "a payment"),
    (ORDER_RE, "an order"),
    (re.compile(r"status: [a-z_]+"), "in progress"),
]
OLD_SUMMARY_BUDGET = 220  # chars of the previous summary that survive each re-summarization


def vague(text: str, rules: list[tuple[re.Pattern[str], str]]) -> str:
    for pattern, replacement in rules:
        text = pattern.sub(replacement, text)
    return text


def sentences(text: str) -> list[str]:
    # A sentence ends at . ? or ! followed by whitespace, so "$129.00" stays in one piece.
    return [s.strip() for s in re.findall(r".+?(?:[.?!](?=\s|$)|$)", text) if s.strip()]


def longest_sentence(text: str) -> str:
    best = ""
    for s in sentences(text):
        if len(s) > len(best):
            best = s
    return best


def scripted_summarizer(params: dict[str, Any]) -> lab.Obj:
    source = lab.last_user_text(params)
    previous = source.split("Previous summary:\n", 1)[1].split("\n\nNew turns:\n", 1)[0]
    new_turns = source.split("\n\nNew turns:\n", 1)[1].split("\n\nWrite the updated summary.", 1)[0]

    kept: list[str] = []
    if previous != "(none)":
        for s in sentences(vague(previous, HEAVY_VAGUE)):
            if len(" ".join(kept + [s])) > OLD_SUMMARY_BUDGET:
                break
            kept.append(s)
    gists = []
    for line in new_turns.split("\n"):
        role, text = line.split(": ", 1)
        gists.append(("Customer: " if role == "user" else "Agent: ") + longest_sentence(vague(text, LIGHT_VAGUE)))
    return lab.message(lab.text(" ".join(kept + gists)))


ISSUE_ROW_RE = re.compile(r"^\| (ISS-\d+) \| (ORD-\d{4}) \| (\$\d+\.\d{2}|unknown) \| ([a-z_]+) \|$", re.M)
PROMISE_RE = re.compile(r'^  - "([^"]+)"$', re.M)
STATUS_SENTENCE_RE = re.compile(r"(\$\d+\.\d{2})[^.]*?(ORD-\d{4}), status: ([a-z_]+)")


def scripted_agent(params: dict[str, Any]) -> lab.Obj:
    """Answers the recap question using ONLY what is visible in the request."""
    visible = visible_text(params)
    rows = ISSUE_ROW_RE.findall(visible)
    promises = PROMISE_RE.findall(visible)
    if rows:
        status_text = "; ".join(f"{order} ({amount}) is {status.replace('_', ' ')}" for _, order, amount, status in rows)
        reply = f"Here is where everything stands: {status_text}."
        if promises:
            reply += f" And as promised, you will get {promises[0]}."
        return lab.message(lab.text(reply))

    # No structured layer: all the model has is the summary and the last few turns.
    latest: dict[str, tuple[str, str]] = {}
    for amount, order, status in STATUS_SENTENCE_RE.findall(visible):
        latest[order] = (amount, status)
    seen = "; ".join(f"{order} ({amount}) is {status.replace('_', ' ')}" for order, (amount, status) in latest.items())
    reply = (f"Here is what I can see: {seen}. " if seen else "") + (
        "Anything else we discussed earlier is still in progress, and we will follow up with you soon."
    )
    return lab.message(lab.text(reply))


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    """One responder for both roles; the system prompt says which job this call is."""
    if lab.system_text(params).startswith(SUMMARIZER_PROMPT):
        return scripted_summarizer(params)
    return scripted_agent(params)
