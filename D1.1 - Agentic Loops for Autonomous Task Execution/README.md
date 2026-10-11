# D1.1: Design and implement agentic loops for autonomous task execution

**Domain 1: Agentic Architecture & Orchestration (27%)** · Task Statement 1.1
**Exam scenarios:** Customer Support Resolution Agent, Developer Productivity with Claude

## What the exam expects

| Knowledge | Skill |
|---|---|
| The loop lifecycle: send a request, inspect `stop_reason` (`"tool_use"` vs `"end_turn"`), execute the requested tools, return the results for the next iteration | Continue while `stop_reason == "tool_use"` and terminate on `"end_turn"` |
| Tool results are appended to the conversation history so the model can reason about its next action | Add tool results to the context between iterations |
| Model-driven decisions (Claude picks the next tool from context) vs pre-configured decision trees | Avoid the anti-patterns: parsing natural language to decide termination, arbitrary iteration caps as the *primary* stop, and treating "the reply contains text" as completion |

## The pattern

```
messages = [user request]
loop:
    response = messages.create(tools, messages)
    messages += assistant(response.content)          # always keep the full turn
    switch response.stop_reason:
        "tool_use" -> results = run every tool_use block
                      messages += user([tool_result ...])   # ONE message, ids matched
                      continue
        "end_turn" -> return final text
        "pause_turn" -> continue (server tool resumed)
        "max_tokens" / "refusal" -> handle explicitly
safety cap reached -> raise (a bug), never "return what we have"
```

## Files

| File | What it shows |
|---|---|
| `python/support_backend.py`, `typescript/supportBackend.ts` | Two tools (`get_customer`, `lookup_order`) with differentiated descriptions, their executors, and a **model-driven** scripted model for offline runs |
| `python/agentic_loop.py`, `typescript/agenticLoop.ts` | The correct loop. Two scenarios show the model choosing a different tool sequence based on what the customer said |
| `python/anti_patterns.py`, `typescript/antiPatterns.ts` | Four broken loops run against the same model, each with a PASS check proving how it fails |

## Run it

```bash
# from the repo root, with the venv active / node_modules installed
python "D1.1 - Agentic Loops for Autonomous Task Execution/python/agentic_loop.py"
python "D1.1 - Agentic Loops for Autonomous Task Execution/python/anti_patterns.py"
npx tsx "D1.1 - Agentic Loops for Autonomous Task Execution/typescript/agenticLoop.ts"
npx tsx "D1.1 - Agentic Loops for Autonomous Task Execution/typescript/antiPatterns.ts"

# against the real API (costs tokens)
python "D1.1 - Agentic Loops for Autonomous Task Execution/python/agentic_loop.py" --live
```

Expected offline output (abridged):

```
--- A - customer identifies by email ---
  iteration 1: stop_reason='tool_use'
    ran get_customer({'email': 'alice@example.com'}) -> {"customer_id": "C-1001", ...}
  iteration 2: stop_reason='tool_use'
    ran lookup_order({'order_id': 'ORD-5521'}) -> {...}
  iteration 3: stop_reason='end_turn'
assistant: Your order ORD-5521 (Wireless headphones) was delivered on 2026-10-02 ...
--- B - customer gives the order ID ---
  tools the model chose, in order: ['lookup_order']   <- different path, same loop
```

## How the anti-patterns fail

| Anti-pattern | What happens in the demo |
|---|---|
| "Reply contains text, so we're done" | Turn 1 is `"Let me pull up your account first."` **plus** a `tool_use` block. The loop returns that progress note and never runs a tool. |
| Iteration cap as the primary stop (`range(2)`) | The task needs 3 calls. The user gets `"Now I'll check the order."` |
| Parsing "final answer" / "I'm done" from text | The model never says the phrase, so every call up to the cap is wasted. Against the real API it would also re-send a conversation that ends on an assistant turn. |
| Hard-coded `get_customer -> lookup_order` pipeline | Scenario B has no email, so step 1 fails. The model-driven loop goes straight to `lookup_order`. |

## Exam traps

- `stop_reason` is the **only** reliable control signal. Text content is not a signal, because Claude often explains what it is about to do in the same turn as the `tool_use`.
- A max-iteration guard is fine as a **runaway safety net** that raises an error. It is wrong as the mechanism that ends normal work.
- Append the **entire** `response.content` as the assistant turn, not just the text. That keeps the `tool_use` blocks the results refer to, plus any thinking blocks.
- Return **all** `tool_result` blocks for one turn in a **single** user message, each with the matching `tool_use_id`. Use `is_error: true` for failures instead of dropping them.
- Model-driven choice is right for open-ended tasks. When the business needs a *guaranteed* order (for example, verify identity before a refund), add programmatic enforcement. See [D1.4](<../D1.4 - Multi-Step Workflows with Enforcement and Handoff/README.md>) and [D1.5](<../D1.5 - Agent SDK Hooks for Interception and Normalization/README.md>).

## SDK notes

- The SDKs also offer a **Tool Runner** (`client.beta.messages.tool_runner` / `toolRunner`) that drives this loop for you. Write the loop by hand once so you understand what the runner automates. That is what the exam tests.
- With `claude-opus-5-5`, thinking is always on, and responses can include `thinking` blocks. Appending `response.content` unchanged keeps them valid for the next request.

## Try this next

1. Add a third tool (`list_orders_for_customer`) and ask "Has my latest order arrived?". Watch the model insert the extra step without any change to the loop.
2. Make `lookup_order` return `is_error: true` for `ORD-9999`, then run `--live` and see how Claude explains the failure to the customer.
