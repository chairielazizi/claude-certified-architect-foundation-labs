"""Support agent shared by the D5.2 demos: prompts, tools, backend, agent loop, scripted models.

Two system prompts are compared:

* ``BASELINE_PROMPT`` - "escalate complex cases". No decision boundary, so the agent guesses.
* ``CRITERIA_PROMPT`` - explicit escalation criteria plus few-shot examples (sample question 3's fix).

Offline, one scripted model stands in for Claude and behaves according to whichever prompt it
receives. With the baseline prompt it reproduces the miscalibration from sample question 3's
logs: it escalates standard damage replacements and improvises policy exceptions. With the
criteria prompt it follows the written criteria. Both profiles decide from the conversation
(what the customer said, which tools ran, what they returned); nothing is keyed to a case id.
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


BACKEND = load_fixture("backend.json")

BASELINE_PROMPT = (
    "You are a customer support agent for an electronics store. Use the tools to help customers. "
    "Escalate complex cases to a human agent."
)

CRITERIA_PROMPT = """You are a customer support agent for an electronics store. Use the tools to help customers.

POLICY
- Damaged on arrival: free replacement when the customer provides photo evidence. No photo yet: ask for one.
- Price adjustment: if OUR site's price drops within 14 days of purchase, refund the difference with apply_price_adjustment.
- Refunds: within 30 days of delivery.
- The policy does NOT cover competitor price matching, bulk or business discounts, or exceptions to the windows above.

ESCALATION CRITERIA (call escalate_to_human with the matching reason_category)
1. explicit_request: the customer explicitly asks for a human, a person or a manager. Escalate immediately.
   Do not look anything up or try to resolve first.
2. policy_gap / policy_exception: the request is something the policy does not cover, or asks for an
   exception to it. Do not improvise a policy.
3. no_progress: you cannot make meaningful progress with your tools (for example, a refund was issued
   but has not arrived and you have no way to trace it).
Do NOT escalate because a case seems complex, emotional or expensive. Straightforward cases the policy
covers are yours to resolve even when the customer is upset: acknowledge the frustration, then resolve.
If the customer only hints that they might want a person, acknowledge it, offer the resolution, and
escalate if they repeat the request.
If a customer lookup returns more than one match, ask for an additional identifier (email or postal
code). Never pick one of the matches by heuristic.

EXAMPLES
Customer: "I want to talk to a real person about my order ORD-1234."
-> escalate_to_human(reason_category="explicit_request") immediately. Do not call lookup_order first.
Customer: "My toaster ORD-2222 arrived with a cracked lid, photo attached."
-> lookup_order, then issue_replacement. Do not escalate: the policy covers it.
Customer: "CompetitorMart sells this for $30 less, can you match it? ORD-3333"
-> lookup_order, then escalate_to_human(reason_category="policy_gap"). The policy covers our own price drops only.
Customer: "THIS IS THE SECOND BROKEN KETTLE!!! ORD-4444, photo attached."
-> Acknowledge the frustration, lookup_order, issue_replacement. Frustration alone is not a trigger.
Customer: "Can you refund ORD-5555? I know it's three months old."
-> lookup_order, then escalate_to_human(reason_category="policy_exception").
"""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "lookup_order",
        "description": "Fetch one order by ID (format ORD-####): item, total, status, dates, refund status and our current site price.",
        "input_schema": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
    },
    {
        "name": "lookup_customer",
        "description": (
            "Find customer accounts by name, email or postal code. Returns a list of matches; a name can "
            "match several accounts. Full account details are only returned for a unique match."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "email": {"type": "string"}, "postal_code": {"type": "string"}},
        },
    },
    {
        "name": "issue_replacement",
        "description": "Ship a free replacement for a damaged item. Policy: only with photo evidence of the damage.",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["order_id", "reason"],
        },
    },
    {
        "name": "apply_price_adjustment",
        "description": "Refund the difference when our own site's price dropped within 14 days of purchase. Amount like '20.00'.",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string"}, "amount": {"type": "string"}},
            "required": ["order_id", "amount"],
        },
    },
    {
        "name": "issue_refund",
        "description": "Refund an order. Policy: within 30 days of delivery. Amount like '59.00'.",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string"}, "amount": {"type": "string"}},
            "required": ["order_id", "amount"],
        },
    },
    {
        "name": "escalate_to_human",
        "description": (
            "Hand the case to a human agent with a structured summary so the customer never has to repeat "
            "themselves. reason_category says which escalation criterion applies."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reason_category": {
                    "type": "string",
                    "enum": ["explicit_request", "policy_gap", "policy_exception", "no_progress", "other"],
                },
                "summary": {"type": "string"},
                "order_id": {"type": "string"},
            },
            "required": ["reason_category", "summary"],
        },
    },
]

RESOLUTION_TOOLS = ("issue_replacement", "apply_price_adjustment", "issue_refund")


def execute_tool(name: str, args: dict[str, Any]) -> tuple[str, bool]:
    """Simulated backend. Returns (json_content, is_error)."""
    if name == "lookup_order":
        order = BACKEND["orders"].get(args.get("order_id", ""))
        return (json.dumps(order), False) if order else (json.dumps({"error": "order not found"}), True)
    if name == "lookup_customer":
        people = BACKEND["customers"]
        if args.get("email"):
            found = [c for c in people if c["email"] == args["email"].lower()]
        elif args.get("postal_code"):
            found = [c for c in people if c["postal_code"] == args["postal_code"]]
        else:
            found = [c for c in people if c["name"].lower() == str(args.get("name", "")).lower()]
        if len(found) > 1:  # several accounts: return only what is needed to disambiguate
            found = [{"customer_id": c["customer_id"], "name": c["name"], "city": c["city"], "last_order_date": c["latest_order"]["date"]} for c in found]
        return json.dumps({"matches": found}), False
    if name == "issue_replacement":
        return json.dumps({"status": "replacement_created", "replacement_id": "RPL-" + args["order_id"][-4:], "ships_within_days": 2}), False
    if name == "apply_price_adjustment":
        return json.dumps({"status": "adjusted", "order_id": args["order_id"], "refunded": args["amount"]}), False
    if name == "issue_refund":
        return json.dumps({"status": "refunded", "order_id": args["order_id"], "amount": args["amount"]}), False
    if name == "escalate_to_human":
        suffix = (args.get("order_id") or "GEN-0001")[-4:]
        return json.dumps({"ticket": f"ESC-{suffix}", "queue": "tier2", "reason_category": args["reason_category"]}), False
    return json.dumps({"error": f"unknown tool {name}"}), True


def pct(n: int, d: int) -> str:
    """n/d as a percentage with one decimal, rounded half-up in integer math (identical in TS)."""
    tenths = (n * 2000 + d) // (2 * d)
    return f"{tenths // 10}.{tenths % 10}%"


def classify(calls: list[str]) -> str:
    """Outcome of a conversation, read from the actions taken (not from the wording)."""
    if "escalate_to_human" in calls:
        return "escalate"
    if any(c in RESOLUTION_TOOLS for c in calls):
        return "resolve"
    return "reply"  # no action taken: the agent answered or asked for something


SAFETY_MAX_ITERATIONS = 10


def run_conversation(client: Any, system: str, user_turns: list[str], verbose: bool = True) -> dict[str, Any]:
    """Agentic loop over one or more customer turns (full history every request)."""
    messages: list[dict[str, Any]] = []
    turn_calls: list[list[str]] = []
    replies: list[str] = []
    for text in user_turns:
        messages.append({"role": "user", "content": text})
        calls: list[str] = []
        for _ in range(SAFETY_MAX_ITERATIONS):  # runaway guard only; stop_reason ends the turn
            response = client.messages.create(
                model=lab.MODEL, max_tokens=16000, system=system, tools=TOOLS, messages=list(messages)
            )
            messages.append({"role": "assistant", "content": response.content})
            if response.stop_reason != "tool_use":
                break
            results = []
            for block in lab.tool_uses(response):
                calls.append(block.name)
                content, is_error = execute_tool(block.name, dict(block.input))
                if verbose:
                    print(f"    -> {block.name}({json.dumps(dict(block.input))})")
                result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
                if is_error:
                    result["is_error"] = True
                results.append(result)
            messages.append({"role": "user", "content": results})
        else:
            raise RuntimeError("agent loop did not converge")
        turn_calls.append(calls)
        replies.append(lab.text_of(response))
    every_call = [c for calls in turn_calls for c in calls]
    return {"turn_calls": turn_calls, "calls": every_call, "replies": replies, "outcome": classify(every_call)}


# ---------------------------------------------------------------------------
# Conversation signals and state (what the scripted model "reads")
# ---------------------------------------------------------------------------

HUMAN_RE = re.compile(r"\b(?:a human|a person|a manager|real person|human agent)\b")
HEDGE_RE = re.compile(r"\b(?:maybe|might|perhaps|should i)\b")
DAMAGE_RE = re.compile(r"\b(?:cracked|broken|dented|chipped|damaged|shattered)\b")
PHOTO_RE = re.compile(r"\b(?:photo|picture)\b")
COMPETITOR_RE = re.compile(r"\bprice-match\b|\bprice match\b|\bmatch (?:their|the|that) price\b|\bcompetitor\b")
OWN_DROP_RE = re.compile(r"\bprice\b.*\bdropped\b|\bdropped the price\b")
EXCEPTION_RE = re.compile(r"\bmake an exception\b|\bpast the \d+-day window\b|\boutside the (?:return )?window\b")
REFUND_MISSING_RE = re.compile(r"\brefund\b.*\b(?:hasn't|has not|never|not yet)\b.*\b(?:arrived|reached|come)\b")
BULK_RE = re.compile(r"\b(?:bulk|business|volume) discount\b")
FRUSTRATED_RE = re.compile(r"!!|\b(?:unbelievable|ridiculous|seriously|fed up|fix this|again)\b")
ACCEPT_RE = re.compile(r"\b(?:yes|ok|okay|fine|go ahead|please do|send it)\b")
ORDER_RE = re.compile(r"ORD-\d{4}")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
NAME_RE = re.compile(r"\b(?:I'm|I am|my name is) ([A-Z][a-z]+ [A-Z][a-z]+)")
OFFER_MARKER = "Shall I go ahead?"


def signals(text: str) -> dict[str, bool]:
    t = text.lower()
    return {
        "damage": bool(DAMAGE_RE.search(t)),
        "photo": bool(PHOTO_RE.search(t)),
        "competitor": bool(COMPETITOR_RE.search(t)),
        "own_site_drop": bool(OWN_DROP_RE.search(t)),
        "exception": bool(EXCEPTION_RE.search(t)),
        "refund_missing": bool(REFUND_MISSING_RE.search(t)),
        "bulk": bool(BULK_RE.search(t)),
        "frustrated": bool(FRUSTRATED_RE.search(t)),
    }


def user_texts(params: dict[str, Any]) -> list[str]:
    """What the customer has typed so far (tool-result messages excluded)."""
    return [m["content"] for m in params["messages"] if m["role"] == "user" and isinstance(m["content"], str)]


def assistant_texts(params: dict[str, Any]) -> list[str]:
    out = []
    for m in params["messages"]:
        if m["role"] == "assistant" and not isinstance(m["content"], str):
            out.append("".join(b.get("text", "") if isinstance(b, dict) else getattr(b, "text", "") or "" for b in m["content"]))
    return out


def conversation_state(params: dict[str, Any]) -> dict[str, Any]:
    """State derived from the full history on every turn (the API itself remembers nothing)."""
    texts = user_texts(params)
    latest = texts[-1].lower() if texts else ""
    return {
        "human_mentions": sum(1 for t in texts if HUMAN_RE.search(t.lower())),
        "explicit_now": bool(HUMAN_RE.search(latest)) and not HEDGE_RE.search(latest),
        "resolution_offered": any(OFFER_MARKER in t for t in assistant_texts(params)),
        "frustrated": any(FRUSTRATED_RE.search(t.lower()) for t in texts),
    }


def cents(amount: str) -> int:
    return int(amount.replace(".", ""))


def money(value: int) -> str:
    return f"{value // 100}.{value % 100:02d}"


def _escalate(ack: str, category: str, summary: str, order_id: str | None) -> lab.Obj:
    args: dict[str, Any] = {"reason_category": category, "summary": summary}
    if order_id:
        args["order_id"] = order_id
    return lab.message(lab.text(ack + "I am bringing in a colleague who can help with this."), lab.tool_use("escalate_to_human", args))


def _after_action(name: str, data: dict[str, Any], ack: str) -> lab.Obj:
    if name == "escalate_to_human":
        return lab.message(lab.text(f"{ack}A human colleague has your case (ticket {data['ticket']}) with a full summary, so you will not need to repeat anything."))
    if name == "issue_replacement":
        return lab.message(lab.text(f"{ack}Your replacement ({data['replacement_id']}) ships within {data['ships_within_days']} days."))
    if name == "apply_price_adjustment":
        return lab.message(lab.text(f"Done: ${data['refunded']} is on its way back to your card for {data['order_id']}."))
    return lab.message(lab.text(f"Done: ${data['amount']} has been refunded for {data['order_id']}."))


def _customer_reply(data: dict[str, Any], pick_by_heuristic: bool) -> lab.Obj:
    matches = data["matches"]
    if len(matches) > 1 and not pick_by_heuristic:
        return lab.message(lab.text(
            f"I found {len(matches)} accounts under that name. So I open the right one, could you confirm "
            "the email address or postal code on your account?"
        ))
    if len(matches) > 1:  # BAD: "most recent activity is probably them"
        chosen = max(matches, key=lambda m: m["last_order_date"])
        full = next(c for c in BACKEND["customers"] if c["customer_id"] == chosen["customer_id"])
    elif matches:
        full = matches[0]
    else:
        return lab.message(lab.text("I could not find an account with those details. Could you double-check them?"))
    order = full["latest_order"]
    return lab.message(lab.text(f"Thanks! Your latest order {order['order_id']} ({order['item']}) is {order['status']} ({full['city']} account)."))


# ---------------------------------------------------------------------------
# Profile 1: explicit criteria + few-shot examples
# ---------------------------------------------------------------------------


def criteria_agent(params: dict[str, Any]) -> lab.Obj:
    texts = user_texts(params)
    latest = texts[-1]
    conversation = " ".join(texts)
    sig = signals(conversation)
    state = conversation_state(params)
    called = lab.all_tool_calls(params)
    results = lab.tool_results(params)
    # Acknowledge frustration in the turn where it is expressed; it is not an escalation trigger.
    ack = "I am sorry about this, I can see how frustrating it is. " if FRUSTRATED_RE.search(latest.lower()) else ""
    order_match = ORDER_RE.search(conversation)
    order_id = order_match.group(0) if order_match else None

    if results:  # react to the tool that just ran
        last, data = called[-1], json.loads(results[-1]["content"])
        if last == "lookup_customer":
            return _customer_reply(data, pick_by_heuristic=False)
        if last != "lookup_order":
            return _after_action(last, data, ack)
        item = data["item"]
        if sig["competitor"] or sig["bulk"]:
            return _escalate(ack, "policy_gap", f"Customer asks for a competitor price match on {order_id}; policy covers only our own price drops.", order_id)
        if sig["exception"]:
            return _escalate(ack, "policy_exception", f"Refund requested for {order_id} outside the 30-day window (delivered {data.get('delivered_on')}).", order_id)
        if sig["refund_missing"] and data.get("refund_status") == "issued":
            return _escalate(ack, "no_progress", f"Refund for {order_id} issued {data['refund_issued_on']} but not received; agent cannot trace bank transfers.", order_id)
        if sig["damage"] and not sig["photo"]:
            return lab.message(lab.text(f"{ack}I am sorry the {item} arrived damaged. Could you send a photo of the damage? Then I can ship a free replacement straight away."))
        if sig["damage"] and state["human_mentions"] == 1 and not state["resolution_offered"]:
            # A hint, not a demand: offer the resolution first and keep the door open.
            return lab.message(lab.text(
                f"{ack}I can ship a free replacement {item} today. {OFFER_MARKER} "
                "If you would still prefer to speak with a person, just tell me."
            ))
        if sig["damage"]:
            return lab.message(lab.text(ack + "That is covered, so I will sort it now."), lab.tool_use("issue_replacement", {"order_id": order_id, "reason": "damaged on arrival, photo provided"}))
        if sig["own_site_drop"] and "current_site_price" in data:
            diff = money(cents(data["total"]) - cents(data["current_site_price"]))
            return lab.message(lab.text(ack + "Our price did drop within 14 days, so you are owed the difference."), lab.tool_use("apply_price_adjustment", {"order_id": order_id, "amount": diff}))
        return lab.message(lab.text(f"Your order {order_id} ({item}) is {data['status'].replace('_', ' ')}."))

    # A new customer message. Explicit requests (or a repeated hint) win before anything else.
    if state["explicit_now"] or state["human_mentions"] >= 2:
        return _escalate(ack, "explicit_request", f"Customer asked for a human. Context: {latest}", order_id)
    if state["resolution_offered"] and ACCEPT_RE.search(latest.lower()) and order_id:
        return lab.message(lab.tool_use("issue_replacement", {"order_id": order_id, "reason": "damaged on arrival, photo provided"}))
    if sig["bulk"]:
        return _escalate(ack, "policy_gap", "Customer asks for a bulk business discount; policy does not cover discounts.", None)
    if order_id and "lookup_order" not in called:
        return lab.message(lab.text(ack + "Let me check that order."), lab.tool_use("lookup_order", {"order_id": order_id}))
    email = EMAIL_RE.search(latest)
    if email:
        return lab.message(lab.tool_use("lookup_customer", {"email": email.group(0)}))
    name = NAME_RE.search(conversation)
    if name and "lookup_customer" not in called:
        return lab.message(lab.tool_use("lookup_customer", {"name": name.group(1)}))
    return lab.message(lab.text("Could you share your order number so I can help?"))


# ---------------------------------------------------------------------------
# Profile 2: vague prompt ("escalate complex cases") - the sample question 3 logs
# ---------------------------------------------------------------------------


def baseline_agent(params: dict[str, Any]) -> lab.Obj:
    conversation = " ".join(user_texts(params))
    sig = signals(conversation)
    called = lab.all_tool_calls(params)
    results = lab.tool_results(params)
    order_match = ORDER_RE.search(conversation)
    order_id = order_match.group(0) if order_match else None

    if results:
        last, data = called[-1], json.loads(results[-1]["content"])
        if last == "lookup_customer":
            return _customer_reply(data, pick_by_heuristic=True)
        if last != "lookup_order":
            return _after_action(last, data, "")
        if HUMAN_RE.search(conversation.lower()):  # honours the request, but only after investigating
            return _escalate("", "explicit_request", "Customer wants a human.", order_id)
        if sig["damage"] and sig["photo"]:  # "damage sounds complex" -> escalates a covered case
            return _escalate("", "other", "Damaged item, seems complex.", order_id)
        if sig["damage"]:
            return lab.message(lab.text("Sorry about that! Could you send a photo of the damage?"))
        if sig["competitor"]:  # improvises a policy that does not exist
            stated = re.search(r"\$(\d+) less", conversation)
            amount = money(int(stated.group(1)) * 100) if stated else money(cents(data["total"]) // 10)
            return lab.message(lab.tool_use("apply_price_adjustment", {"order_id": order_id, "amount": amount}))
        if sig["exception"]:  # grants an exception nobody approved
            return lab.message(lab.tool_use("issue_refund", {"order_id": order_id, "amount": data["total"]}))
        if sig["refund_missing"]:
            return _escalate("", "no_progress", "Customer has not received refund.", order_id)
        if sig["own_site_drop"] and "current_site_price" in data:
            diff = money(cents(data["total"]) - cents(data["current_site_price"]))
            return lab.message(lab.tool_use("apply_price_adjustment", {"order_id": order_id, "amount": diff}))
        return lab.message(lab.text(f"Your order {order_id} is {data['status'].replace('_', ' ')}."))

    if order_id and "lookup_order" not in called:  # always investigates first
        return lab.message(lab.text("Let me look into that."), lab.tool_use("lookup_order", {"order_id": order_id}))
    if sig["bulk"]:
        return lab.message(lab.text("Great news: I can offer your studio 15% off all future orders with code STUDIO15."))
    name = NAME_RE.search(conversation)
    if name and "lookup_customer" not in called:
        return lab.message(lab.tool_use("lookup_customer", {"name": name.group(1)}))
    return lab.message(lab.text("How can I help?"))


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    """The same stand-in model; its behaviour depends on the system prompt it was given."""
    if "ESCALATION CRITERIA" in lab.system_text(params):
        return criteria_agent(params)
    return baseline_agent(params)
