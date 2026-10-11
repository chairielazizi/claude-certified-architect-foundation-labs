"""D1.4 - Multi-concern requests: decompose, investigate in parallel with shared context, unify.

    "ORD-1001 arrived damaged AND I was double-charged on invoice INV-77"
      1. decompose      -> two distinct concerns, each with its own reference
      2. verify ONCE    -> get_customer through the gate; the verified facts become shared context
      3. investigate    -> one investigator per concern, run concurrently (asyncio.gather), each
                           given the shared verified-customer context instead of re-verifying
      4. act            -> proposed refunds go through the same gated tool layer
      5. synthesise     -> ONE reply that resolves both items

Run:  python multi_concern.py          (offline, 0.3 s simulated latency per model call)
      python multi_concern.py --live   (real API)
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_tools import TOOLS, ToolLayer, tag  # noqa: E402

REQUEST = "Hi, it's jordan@example.com. ORD-1001 arrived damaged AND I was double-charged on invoice INV-77."
LATENCY_S = 0.3
SAFETY_MAX_ITERATIONS = 8

DECOMPOSER_PROMPT = (
    "ROLE: request decomposer\n"
    "Split the customer's message into distinct concerns, one per issue, each with the order or invoice it "
    "refers to and the customer's own words. Also extract the customer's email. Return JSON."
)
INVESTIGATOR_PROMPT = (
    "ROLE: concern investigator\n"
    "Investigate ONE concern for a customer whose identity is already verified (see <verified_customer>); do "
    "not re-verify. Use lookup_order or lookup_invoice to establish the facts. Do not process refunds. Finish "
    "with only a JSON object: {concern_id, facts, root_cause, proposed_refund: {reference_id, amount, reason} or null}."
)
RESOLUTION_PROMPT = (
    "ROLE: resolution writer\n"
    "Write ONE reply to the customer that resolves every concern below, using the investigation results and the "
    "actions already taken. Address the customer by name, cover each item, and state the total refunded."
)

DECOMPOSITION_SCHEMA = {
    "type": "object",
    "properties": {
        "customer_email": {"type": "string"},
        "concerns": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "concern_id": {"type": "string"},
                "kind": {"type": "string", "enum": ["damaged_item", "billing_error", "delivery", "other"]},
                "reference_id": {"type": "string"},
                "customer_words": {"type": "string"},
            },
            "required": ["concern_id", "kind", "reference_id", "customer_words"],
            "additionalProperties": False,
        }},
    },
    "required": ["customer_email", "concerns"],
    "additionalProperties": False,
}
# Investigators only read: refunds stay with the coordinator, behind the gate.
READ_ONLY_TOOLS = [t for t in TOOLS if t["name"] in ("lookup_order", "lookup_invoice")]


def parse_json_reply(text: str) -> Any:
    """JSON from a reply that may wrap it in prose (live models sometimes do)."""
    try:
        return json.loads(text)
    except ValueError:
        return json.loads(text[text.index("{"): text.rindex("}") + 1])


# ---------------------------------------------------------------------------
# Offline stand-ins, dispatched on the role tag of the system prompt
# ---------------------------------------------------------------------------


def _decompose(params: dict[str, Any]) -> lab.Obj:
    request = lab.last_user_text(params)
    concerns = []
    for n, clause in enumerate(re.split(r"\s+AND\s+", request), 1):
        ref = re.search(r"(ORD-\d+|INV-\d+)", clause)
        if not ref:
            continue
        kind = "billing_error" if re.search(r"double-charged|charged twice", clause) else "damaged_item" if "damaged" in clause else "other"
        words = next(s for s in re.split(r"(?<=[.!?])\s+", clause) if ref.group(1) in s)
        concerns.append({"concern_id": f"c{n}", "kind": kind, "reference_id": ref.group(1), "customer_words": words.strip()})
    email = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", request).group(0)
    return lab.message(lab.text(json.dumps({"customer_email": email, "concerns": concerns})))


def _investigate(params: dict[str, Any]) -> lab.Obj:
    task = params["messages"][0]["content"]
    concern = json.loads(tag(task, "concern"))
    results = lab.tool_results(params)
    ref = concern["reference_id"]
    if not results:
        tool, key = ("lookup_invoice", "invoice_id") if ref.startswith("INV-") else ("lookup_order", "order_id")
        return lab.message(lab.tool_use(tool, {key: ref}))
    record = json.loads(results[-1]["content"])
    if concern["kind"] == "billing_error":
        seen: dict[tuple[float, str], str] = {}
        duplicates = []
        for charge in record["charges"]:
            key = (charge["amount"], charge["date"])
            if key in seen:
                duplicates.append(charge)
            seen.setdefault(key, charge["charge_id"])
        dup = duplicates[0]
        finding = {
            "concern_id": concern["concern_id"],
            "facts": f"{record['description']}: {len(record['charges'])} charges of ${dup['amount']:.2f} on {dup['date']}",
            "root_cause": f"Duplicate charge {dup['charge_id']} (same amount and date as {seen[(dup['amount'], dup['date'])]})",
            "proposed_refund": {"reference_id": ref, "amount": round(sum(d["amount"] for d in duplicates), 2), "reason": "Duplicate charge"},
        }
    else:
        finding = {
            "concern_id": concern["concern_id"],
            "facts": f"{record['item']}, ${record['total']:.2f}, {record['status']} {record['delivered_on']}",
            "root_cause": "Damaged in transit (reported by the customer on arrival)",
            "proposed_refund": {"reference_id": ref, "amount": record["total"], "reason": "Damaged on arrival"},
        }
    return lab.message(lab.text(json.dumps(finding)))


def _resolve(params: dict[str, Any]) -> lab.Obj:
    task = lab.last_user_text(params)
    customer = json.loads(tag(task, "verified_customer"))
    findings = json.loads(tag(task, "investigations"))
    actions = {a["concern_id"]: a for a in json.loads(tag(task, "actions"))}
    lines = [f"Hi {customer['name'].split()[0]}, I looked into both issues:"]
    total = 0.0
    for n, finding in enumerate(findings, 1):
        action = actions.get(finding["concern_id"])
        if action and action["ok"]:
            total += action["result"]["amount"]
            outcome = f"refunded ${action['result']['amount']:.2f} ({action['result']['refund_id']})"
        else:
            outcome = "passed to a specialist"
        lines.append(f"{n}. {finding['proposed_refund']['reference_id']}: {finding['root_cause']} - {outcome}.")
    lines.append(f"Total refunded: ${total:.2f}, back to your original payment method.")
    return lab.message(lab.text("\n".join(lines)))


_HANDLERS = {p.splitlines()[0]: h for p, h in ((DECOMPOSER_PROMPT, _decompose), (INVESTIGATOR_PROMPT, _investigate), (RESOLUTION_PROMPT, _resolve))}


def scripted_team(params: dict[str, Any]) -> lab.Obj:
    return _HANDLERS[lab.system_text(params).splitlines()[0]](params)


# ---------------------------------------------------------------------------
# The workflow
# ---------------------------------------------------------------------------


def investigation_task(concern: dict[str, Any], shared: dict[str, Any]) -> str:
    """The shared verified context goes INTO each investigator's prompt (it has no other memory)."""
    return (
        f"<verified_customer>{json.dumps(shared['verified_customer'])}</verified_customer>\n"
        f"<concern>{json.dumps(concern)}</concern>\n"
        "Investigate this concern and return the JSON object."
    )


async def investigate(client: Any, tools: ToolLayer, concern: dict[str, Any], task: str) -> dict[str, Any]:
    """One concern, one small agent loop over read-only tools."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    for _ in range(SAFETY_MAX_ITERATIONS):
        response = await client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=INVESTIGATOR_PROMPT, tools=READ_ONLY_TOOLS, messages=messages
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return parse_json_reply(lab.text_of(response))
        results = []
        for block in lab.tool_uses(response):
            content, is_error = tools.execute(block.name, block.input)  # same gate, already verified
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": content, **({"is_error": True} if is_error else {})})
        messages.append({"role": "user", "content": results})
    raise RuntimeError(f"Investigation of {concern['concern_id']} did not finish")


async def handle(client: Any, tools: ToolLayer, request: str) -> dict[str, Any]:
    # 1. decompose
    response = await client.messages.create(
        model=lab.MODEL, max_tokens=4000, system=DECOMPOSER_PROMPT,
        output_config={"format": {"type": "json_schema", "schema": DECOMPOSITION_SCHEMA}},
        messages=[{"role": "user", "content": request}],
    )
    decomposition = json.loads(lab.text_of(response))
    concerns = decomposition["concerns"]

    # 2. verify once; the verified facts are the context every investigator shares
    content, is_error = tools.execute("get_customer", {"email": decomposition["customer_email"]})
    if is_error:
        raise RuntimeError(f"verification failed: {content}")
    shared = {"verified_customer": json.loads(content)}

    # 3. investigate every concern concurrently
    t0 = time.perf_counter()
    timeline: dict[str, tuple[float, float]] = {}
    tasks = {c["concern_id"]: investigation_task(c, shared) for c in concerns}

    async def timed(concern: dict[str, Any]) -> dict[str, Any]:
        start = time.perf_counter() - t0
        finding = await investigate(client, tools, concern, tasks[concern["concern_id"]])
        timeline[concern["concern_id"]] = (start, time.perf_counter() - t0)
        return finding

    findings = list(await asyncio.gather(*(timed(c) for c in concerns)))
    investigation_s = time.perf_counter() - t0

    # 4. act: refunds go through the gated tool layer, never straight to the backend
    actions = []
    for finding in findings:
        if finding.get("proposed_refund"):
            refund_args = {"customer_id": shared["verified_customer"]["customer_id"], **finding["proposed_refund"]}
            content, is_error = tools.execute("process_refund", refund_args)
            actions.append({"concern_id": finding["concern_id"], "tool": "process_refund", "ok": not is_error, "result": json.loads(content)})

    # 5. one unified resolution
    resolution_task = (
        f"<verified_customer>{json.dumps(shared['verified_customer'])}</verified_customer>\n"
        f"<concerns>{json.dumps(concerns)}</concerns>\n"
        f"<investigations>{json.dumps(findings)}</investigations>\n"
        f"<actions>{json.dumps(actions)}</actions>\n"
        "Write the single reply to the customer."
    )
    response = await client.messages.create(
        model=lab.MODEL, max_tokens=16000, system=RESOLUTION_PROMPT, messages=[{"role": "user", "content": resolution_task}]
    )
    return {"concerns": concerns, "shared": shared, "tasks": tasks, "findings": findings, "actions": actions,
            "reply": lab.text_of(response), "timeline": timeline, "investigation_s": investigation_s}


async def demo() -> None:
    print(f"user: {REQUEST}")
    tools = ToolLayer(enforce=True)
    client = lab.get_async_client(scripted_team, latency_s=LATENCY_S)
    out = await handle(client, tools, REQUEST)

    lab.section("1. Decomposition")
    for c in out["concerns"]:
        print(f"  {c['concern_id']} {c['kind']:<14} {c['reference_id']:<9} \"{c['customer_words']}\"")
    lab.section("2. Shared context (verified once)")
    print(f"  {out['shared']['verified_customer']}")
    lab.section("3. Parallel investigations")
    for f in out["findings"]:
        start, end = out["timeline"][f["concern_id"]]
        print(f"  {f['concern_id']} [{start:.2f}s -> {end:.2f}s] {f['root_cause']}; proposed refund {f['proposed_refund']}")
    print(f"  investigation wall-clock: {out['investigation_s']:.2f}s")
    lab.section("4. Actions through the gate")
    for a in out["actions"]:
        print(f"  {a['concern_id']} {a['tool']} ok={a['ok']} -> {a['result']}")
    lab.section("5. Unified resolution")
    print("  " + out["reply"].replace("\n", "\n  "))

    tool_sequence = [c["tool"] for c in tools.calls]
    print(f"tool calls: {tool_sequence}")
    lab.check(tool_sequence.count("get_customer") == 1 and tool_sequence[0] == "get_customer",
              "the customer was verified exactly once, before any investigation")
    lab.check(all(c["outcome"] == "ok" for c in tools.calls), "no call was blocked: investigators worked from the shared verified context")
    lab.check(len(out["actions"]) == len(out["concerns"]) and all(a["ok"] for a in out["actions"]),
              "each concern's refund went through the gated tool layer")
    verified_id = out["shared"]["verified_customer"]["customer_id"]
    lab.check(all(verified_id in task for task in out["tasks"].values()),
              f"every investigator's prompt carried the shared verified customer ({verified_id})")
    if not lab.is_live():
        refs = {c["reference_id"] for c in out["concerns"]}
        lab.check(len(out["concerns"]) == 2 and refs == {"ORD-1001", "INV-77"}, "decomposed into 2 distinct concerns: ORD-1001 and INV-77")
        (s1, e1), (s2, e2) = out["timeline"].values()
        lab.check(max(s1, s2) < min(e1, e2), "the investigations overlapped in time (run concurrently)")
        lab.check(out["investigation_s"] < 2 * 2 * LATENCY_S * 0.75,
                  f"parallel investigation took {out['investigation_s']:.2f}s vs ~{4 * LATENCY_S:.1f}s sequentially")
        lab.check("ORD-1001" in out["reply"] and "INV-77" in out["reply"] and "$178.99" in out["reply"],
                  "one reply resolves both concerns and states the total ($178.99)")


def main() -> None:
    lab.banner("D1.4  Multi-concern request: decompose, investigate in parallel, unify")
    lab.run(demo())


if __name__ == "__main__":
    main()
