# D1.5: Apply Agent SDK hooks for tool call interception and data normalization

**Domain 1: Agentic Architecture & Orchestration (27%)** · Task Statement 1.5
**Exam scenarios:** Customer Support Resolution Agent (custom MCP tools, refund policy, human escalation)

## What the exam expects

| Knowledge | Skill |
|---|---|
| `PostToolUse` hooks intercept tool results and transform them before the model processes them | Normalize mixed formats from different MCP tools (Unix timestamps, ISO 8601, numeric status codes) into one shape in a `PostToolUse` hook |
| `PreToolUse` hooks intercept outgoing tool calls to enforce compliance rules, for example blocking refunds above a threshold | Block policy-violating calls (refund > $500) and redirect the agent to another workflow (`escalate_to_human`) |
| Hooks give deterministic guarantees. Prompt instructions give probabilistic compliance | Choose hooks over prompt-based enforcement when a business rule must hold every time |

## The pattern

```
model emits tool_use  mcp__shop__process_refund {amount: 750}
        |
        v
PreToolUse hooks   (matcher tests the tool NAME; the callback inspects tool_input)
        |-- "deny" + reason ---> handler never runs; the model gets the reason as an error
        |                        result ("... call escalate_to_human ...") and adapts
        | {} or "allow"
        v
tool handler       raw backend output: epoch 1790932500, status 3, "10/06/2026"
        |
        v
PostToolUse hooks  hookSpecificOutput.updatedToolOutput = canonical record
        |          {"status": "delivered", "created_at": "2026-10-02T09:15:00Z", "total": 750.0}
        v
model reads the canonical record only
```

```python
options = ClaudeAgentOptions(
    mcp_servers={"shop": SHOP_SERVER},                  # create_sdk_mcp_server(...)
    allowed_tools=["mcp__shop__get_order_legacy", ...],  # auto-approve; hooks still run first
    hooks={
        "PreToolUse":  [HookMatcher(matcher="mcp__shop__process_refund", hooks=[enforce_refund_limit])],
        "PostToolUse": [HookMatcher(matcher="^mcp__shop__get_", hooks=[normalize_shop_output])],
    },
)
```

## Files

| File | What it shows |
|---|---|
| `python/shop_server.py`, `typescript/shopServer.ts` | In-process SDK MCP server `shop` (`@tool` + `create_sdk_mcp_server` / `tool()` + `createSdkMcpServer`). Three lookups that disagree on formats, plus `process_refund` (no limit in the backend) and `escalate_to_human` |
| `python/hooks.py`, `typescript/hooks.ts` | The two hooks: the `PostToolUse` normalizer (`updatedToolOutput`) and the `PreToolUse` refund guard (`permissionDecision: "deny"` + redirecting reason), plus the `HOOKS` config |
| `python/harness.py`, `typescript/harness.ts` | `simulate_tool_call()`: PreToolUse -> handler -> PostToolUse, the order the SDK applies them, plus the offline agent loop |
| `python/scripted_model.py`, `typescript/scriptedModel.ts` | Model-driven offline stand-in. It follows a prompt-stated limit *most* of the time and follows a deny reason that names a tool |
| `python/hook_demo.py`, `typescript/hookDemo.ts` | Unit tests for the hooks: call the callbacks and the tool handlers directly with realistic `input_data` |
| `python/compliance_comparison.py`, `typescript/complianceComparison.ts` | 100 seeded refund attempts: prompt-only vs prompt + hook, same model and same random draws |
| `python/support_agent.py`, `typescript/supportAgent.ts` | End to end: `$750` refund -> deny -> escalation. `--live` runs `query()` with the real hooks and MCP server |

## Run it

```bash
# from the repo root
python "D1.5 - Agent SDK Hooks for Interception and Normalization/python/hook_demo.py"
python "D1.5 - Agent SDK Hooks for Interception and Normalization/python/compliance_comparison.py"
python "D1.5 - Agent SDK Hooks for Interception and Normalization/python/support_agent.py"
npx tsx "D1.5 - Agent SDK Hooks for Interception and Normalization/typescript/hookDemo.ts"
npx tsx "D1.5 - Agent SDK Hooks for Interception and Normalization/typescript/complianceComparison.ts"
npx tsx "D1.5 - Agent SDK Hooks for Interception and Normalization/typescript/supportAgent.ts"

# Agent SDK + real Claude (costs tokens)
python "D1.5 - Agent SDK Hooks for Interception and Normalization/python/support_agent.py" --live
```

Expected offline output (abridged):

```
--- 2. PostToolUse normalizer, called directly ---
get_order_legacy ->
  {"record_type": "order", "order_id": "ORD-1001", ..., "status": "delivered", "created_at": "2026-10-02T09:15:00Z", ..., "total": 750.0}
  [PASS] legacy numeric status 3 became 'delivered'
  [PASS] MM/DD/YYYY 10/06/2026 read as 6 October, not 10 June

--- Comparison ---
                               prompt only   prompt + hook
refunds_over_limit                       6               0
refunds_within_limit                    40              40
hook_denials                             0               6
  [PASS] hook enforcement is deterministic: zero refunds above $500 executed

--- Agent run ---
  tool_use get_order_legacy({'order_id': 'ORD-1001'}) -> EXECUTED
      PostToolUse[^mcp__shop__get_] -> replaced output
  tool_use process_refund({... 'amount': 750.0 ...}) -> DENIED by PreToolUse
      model sees: Refund of $750.00 exceeds the $500.00 limit ... Call escalate_to_human ...
  tool_use escalate_to_human({... 'amount': 750.0 ...}) -> EXECUTED
  assistant: I can't approve $750.00 myself, so I've escalated ORD-1001 to a human agent (ticket ESC-0001).
```

## Hooks vs prompt instructions

| | Prompt instruction ("never refund above $500") | `PreToolUse` hook |
|---|---|---|
| Who enforces it | The model, every turn, from memory of the instruction | Your code, on every call, before the tool runs |
| Guarantee | Probabilistic. With a simulated 6% violation rate, the scripted model ignored the rule on 6 of 60 over-limit requests in this seed. Real rates vary but are never exactly 0 | Deterministic. 0 of the 60 over-limit requests executed a refund |
| Failure mode | Silent: the refund just happens | Visible: a deny with a reason, logged in `HOOK_EVENTS` / `ResultMessage.permission_denials` |
| Good for | Tone, style, preferences, soft heuristics | Money, safety, compliance, anything with legal or financial consequences |

Keep the rule in the prompt as well. It lets the agent plan around the limit, so fewer calls get denied. The hook is what guarantees the outcome.

The same reasoning applies to normalization. Telling the model "status 3 means delivered, dates are MM/DD/YYYY" in the prompt costs tokens on every turn, and the model can still misread `10/06/2026`. A `PostToolUse` hook converts once, in code, per tool.

## Exam traps

- **"Strengthen the system prompt" is the distractor for guaranteed rules.** Sample Q1 has the same structure: when errors have financial consequences, programmatic enforcement beats prompt instructions and few-shot examples, because those are probabilistic.
- **Matchers match tool names, not arguments.** `"mcp__shop__process_refund"` selects the tool, and the `amount > 500` test lives inside the callback. A regex matcher like `"^mcp__shop__get_"` covers a family of tools.
- **`PostToolUse` cannot block.** The tool has already run. Use `PreToolUse` to stop side effects, and `PostToolUse` to change what the model *sees*.
- **A bare deny is not enough.** Put the alternative workflow in `permissionDecisionReason` ("call escalate_to_human with ..."). Otherwise the agent may retry or give up.
- **`allowed_tools` does not bypass hooks.** Auto-approval skips the permission prompt, but `PreToolUse` still runs, and a deny beats any allow. Returning `{}` means "no opinion", so the hook never grants more than the configuration does.
- **Fail closed.** If the hook cannot parse the amount, deny. A guard that allows on malformed input is not a guard.
- **Normalize at the boundary, not in the model.** Inconsistent formats across MCP tools are a data problem. Solve them deterministically before they reach the context.

## SDK notes

- Python callback: `async def cb(input_data: dict, tool_use_id: str | None, context: HookContext) -> dict`. TS: `const cb: HookCallback = async (input, toolUseID, { signal }) => {...}`. Both can be unit-tested by calling them directly, as `hook_demo.py` does.
- Use `updatedToolOutput`. It works for every tool. `updatedMCPToolOutput` is the older, MCP-only field and is deprecated. For built-in tools the replacement must match that tool's output schema.
- The exact `tool_response` shape the CLI hands a hook for MCP tools is not pinned down here. The normalizer accepts a content-block list, an object with `content`, or a string, and returns its replacement in the same shape.
- When several `PostToolUse` hooks match one tool, each one sees the **original** output, and if more than one rewrites it the last write wins. Make exactly one hook responsible for rewriting a given tool's output. The offline harness behaves the same way.
- `tools=[]` (TS `tools: []`) removes the built-in tools, so this agent can only use the shop server. Tool names seen by the model and by matchers are `mcp__<server>__<tool>`.
- The matcher rules in `harness.matcher_matches` approximate Claude Code: `*` or empty matches all, plain names (letters, digits, `_`, `|`) match exactly, anything else is a regex.

## Try this next

1. Add `get_order_v3` that returns epoch **milliseconds** and `"status": "OUT_FOR_DELIVERY"`. Extend `NORMALIZERS` and check that nothing in the prompt or the scripted model had to change.
2. Add a second `PreToolUse` hook on `process_refund` that uses `updatedInput` to round `amount` to cents, and confirm the deny still wins for $750.
3. Run `support_agent.py --live` with the $500 rule added to `SYSTEM_PROMPT`. Claude will usually escalate without ever triggering the hook. That is the "plan around it" benefit, and the ledger check still proves the guarantee.
