# D1.4: Implement multi-step workflows with enforcement and handoff patterns

**Domain 1: Agentic Architecture & Orchestration (27%)** · Task Statement 1.4
**Exam scenarios:** Customer Support Resolution Agent

## What the exam expects

| Knowledge | Skill |
|---|---|
| Programmatic enforcement (hooks, prerequisite gates) differs from prompt-based guidance for workflow ordering | Implement programmatic prerequisites that block downstream tool calls until the prerequisite steps have completed, e.g. block `process_refund` until `get_customer` has returned a verified customer ID |
| When compliance must be deterministic (identity verification before financial operations), prompt instructions alone still fail some of the time | Decompose a multi-concern request into distinct items, investigate each in parallel using shared context, then synthesise one unified resolution |
| Structured handoff protocols for mid-process escalation include customer details, root cause analysis and recommended actions | Compile structured handoff summaries (customer ID, root cause, refund amount, recommended action) for human agents who cannot see the transcript |

## The pattern

```
model -> tool_use ---> ToolLayer.execute(name, args)              <- every call passes here
                         | check_prerequisites()   (enforce=True)
                         |   no verified customer?  -> is_error {"error": "prerequisite_not_met",
                         |                                       "missing_prerequisite": "get_customer"}
                         |   refund: id != verified / not looked up / not owner / > $500 -> is_error
                         | check_handoff()          (always)
                         |   escalate_to_human missing fields -> is_error {"problems": [...]}
                         +-> backend
model reads the is_error result and recovers (verify first, or escalate with a full HandoffSummary)

multi-concern:  decompose -> get_customer ONCE (shared context) -> gather(investigate c1, investigate c2)
                -> refunds through the same gate -> one unified reply
```

## Files

| File | What it shows |
|---|---|
| `python/support_tools.py`, `typescript/supportTools.ts` | Data (two customers named "Jordan Lee" on purpose), five tools, the `ToolLayer` gate (`enforce=True`) and its prompt-only twin (`enforce=False`), `HandoffSummary` with `validate_handoff()` and `render_ticket()`, the agent loop, and a model-driven scripted support model |
| `python/prerequisite_gate.py`, `typescript/prerequisiteGate.ts` | Sample Q1. The model tries `process_refund` with the typed name and gets blocked, then verifies and proceeds. Then 100 seeded synthetic runs compare prompt-only enforcement with the gate |
| `python/multi_concern.py`, `typescript/multiConcern.ts` | "ORD-1001 arrived damaged AND I was double-charged on invoice INV-77": decomposition, one verification shared by all, concurrent investigators (`asyncio.gather` / `Promise.all`), gated refunds, and one reply |
| `python/handoff.py`, `typescript/handoff.ts` | An $899 refund exceeds the $500 agent limit, so the gate blocks it and the model escalates with a validated `HandoffSummary`. Also shows what the human sees, and how a free-text handoff gets rejected |

`lookup_invoice` is a fifth tool beyond the scenario's four, because a double charge lives on an invoice, not an order.

## Run it

```bash
# from the repo root
python "D1.4 - Multi-Step Workflows with Enforcement and Handoff/python/prerequisite_gate.py"
python "D1.4 - Multi-Step Workflows with Enforcement and Handoff/python/multi_concern.py"
python "D1.4 - Multi-Step Workflows with Enforcement and Handoff/python/handoff.py"
npx tsx "D1.4 - Multi-Step Workflows with Enforcement and Handoff/typescript/prerequisiteGate.ts"
npx tsx "D1.4 - Multi-Step Workflows with Enforcement and Handoff/typescript/multiConcern.ts"
npx tsx "D1.4 - Multi-Step Workflows with Enforcement and Handoff/typescript/handoff.ts"

# against the real API (the gate and validation are identical; only the model changes)
python "D1.4 - Multi-Step Workflows with Enforcement and Handoff/python/handoff.py" --live
```

Expected offline output (abridged):

```
--- A - the gate blocks a refund attempted before verification ---
  process_refund({"customer_id": "Jordan Lee", "reference_id": "ORD-1001", ...})
     -> is_error {"error": "prerequisite_not_met", "blocked_tool": "process_refund", "missing_prerequisite": "get_customer", ...}
  get_customer({"email": "jordan@example.com"})  -> {"customer_id": "C-2001", ..., "verified": true}
tool calls: ['process_refund:blocked', 'get_customer:ok', 'lookup_order:ok', 'process_refund:ok']

--- B - 100 synthetic runs: prompt-only vs gate ---
  mode         runs  skipped  blocked  unverified  misdirected  completed
  prompt-only   100       12        0          12           12        100
  gate          100       12       12           0            0        100
  [PASS] gate: 0 violations

--- 3. Parallel investigations ---
  c1 [0.00s -> 0.62s] Damaged in transit ...; proposed refund {'reference_id': 'ORD-1001', 'amount': 129.0, ...}
  c2 [0.00s -> 0.62s] Duplicate charge CH-502 ...; proposed refund {'reference_id': 'INV-77', 'amount': 49.99, ...}

--- What the human agent sees (no transcript, only this ticket) ---
[HD-4401] priority=HIGH  customer=C-2002
Root cause:  Damaged in transit (customer reports a cracked screen). The $899.00 refund is above the $500 agent limit ...
Refund:      $899.00
```

## Prompt-only vs programmatic enforcement

| | System prompt says "always verify first" | Prerequisite gate in the tool layer |
|---|---|---|
| Who enforces the order | the model, probabilistically | code, on every call |
| 100 runs with a 12% skip rate | 12 unverified refunds, all 12 credited to the **other** Jordan Lee | 0. The 12 attempts were blocked and the model recovered |
| What the model sees on a violation | nothing (the refund just runs) | a structured `is_error` result naming `missing_prerequisite` |
| Happy path | unchanged | unchanged (100 of 100 refunds completed) |

The skip behaviour is synthetic: a seeded Park-Miller PRNG (seed `20261011`) produces exactly 12 skips in 100 runs. The Python and TypeScript runs produce the same numbers.

## Exam traps

- **Sample Q1.** In 12% of cases the agent skips `get_customer` and acts on the customer's stated name. The answer is **A, a programmatic prerequisite** that blocks `lookup_order` and `process_refund` until a verified customer ID exists. A stronger system prompt (B) and few-shot examples (C) are still probabilistic, which isn't good enough when money moves. A routing classifier (D) controls which tools are *available*, not the *order* they're used in.
- **"Blocking" means returning a usable error.** Blocking doesn't mean crashing or silently dropping the call. The gate returns `is_error: true` with the missing prerequisite, so the model can fix its plan within the same loop.
- **Verify once, share the result.** For multi-concern requests, decompose first, verify identity once, and pass the verified facts into every parallel investigator's prompt. Don't let each investigator re-verify, and don't handle the concerns one at a time in a single long thread. Finish with **one** unified reply, not one reply per concern.
- **Handoffs must stand on their own.** The human agent has no transcript. "Customer upset, see chat" is useless to them. Include the verified customer ID, issue, root cause, refund amount, actions already taken (including the blocked attempt), recommended action and priority, and validate those fields in code.
- **A name is not an identity.** Two customers named "Jordan Lee" show why `customer_id` must come from a successful `get_customer` and never from the chat.
- The same kind of guarantee can be implemented as an Agent SDK `PreToolUse` hook (deny + reason). See [D1.5](<../D1.5 - Agent SDK Hooks for Interception and Normalization/README.md>). Escalation criteria are covered in [D5.2](<../D5.2 - Escalation and Ambiguity Resolution Patterns/README.md>).

## SDK notes

- The gate lives in your tool-execution code, so it works the same with the Messages API, the Tool Runner, or as an MCP server's tool handler. In the Agent SDK, the idiomatic place for it is a `PreToolUse` hook.
- `escalate_to_human` could also set `"strict": true` on its tool definition to get schema-valid input. Keep the code-side `validate_handoff()` regardless: it checks things a schema can't, such as "is this the *verified* id?".
- Live mode uses `output_config` structured outputs for the decomposition step. Investigator replies are parsed leniently, because a tool-using turn can end with prose around the JSON.

## Try this next

1. Add a policy-exception path: an order delivered more than 30 days ago is outside the return window. Make the gate return `{"error": "policy_exception"}` and have the model escalate with `priority: "normal"`.
2. Add a third concern to the multi-concern request (for example "and ORD-2002 hasn't arrived"). Check that the investigation wall-clock stays about the same.
3. Change `SKIP_RATE` to 0.02 and rerun `prerequisite_gate.py`. The prompt-only failures drop but don't reach zero, which is the point of the exam's "non-zero failure rate".
