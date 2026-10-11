# D2.2: Implement structured error responses for MCP tools

**Domain 2: Tool Design & MCP Integration (18%)** · Task Statement 2.2
**Exam scenarios:** Customer Support Resolution Agent, Multi-Agent Research System

## What the exam expects

| Knowledge | Skill |
|---|---|
| The MCP `isError` flag reports a tool failure back to the agent | Return structured error metadata: `errorCategory` (transient/validation/permission), an `isRetryable` boolean, and a human-readable description |
| Four kinds of error: transient (timeouts, service unavailable), validation (bad input), business (policy violation), and permission | For business-rule violations, return `isRetryable: false` and a customer-friendly explanation the agent can pass on |
| A uniform "Operation failed" stops the agent from choosing the right recovery | Recover locally inside the subagent for transient failures. Propagate to the coordinator only what can't be resolved there, with partial results and what was attempted |
| Retryable and non-retryable errors are different. Structured metadata prevents wasted retries | Separate access failures (need a retry decision) from valid empty results (a successful query with no matches) |

## The pattern

```
tool fails  ->  CallToolResult { isError: true,
                                 content: [{type: "text", text: JSON envelope}] }

envelope = { errorCategory, isRetryable, message (for the agent),
             customerMessage (business rules), retryAfterSeconds (transient), details }

subagent policy:
  transient & isRetryable -> wait retryAfterSeconds / backoff -> retry SAME call (max 3)
  validation              -> fix input from details (#1002 -> ORD-1002) or ask the user
  business                -> never retry; explain with customerMessage
  permission              -> never retry; escalate
  still unresolved        -> return {status: partial, results: [...done], unresolved: {...error},
                                     attempts: [...], not_attempted: [...]} to the coordinator

search with 0 hits      -> SUCCESS {"results": [], "matched": 0}   (not isError)
```

## Files

| File | What it shows |
|---|---|
| `python/support_server.py`, `typescript/supportServer.ts` | The MCP server (Python `MCPServer` from mcp 2.x, TS `McpServer` from the v1 SDK) with `lookup_order`, `process_refund`, and `search_kb`. It includes a fake backend with injectable timeouts, an outage switch, a $500 refund limit, and a corporate-account scope. `build_server(backend, "generic")` is the contrast variant that returns `"Operation failed"` for every failure, including empty searches. It runs as a stdio server only with `--serve` |
| `python/recovery_policy.py`, `typescript/recoveryPolicy.ts` | The agent-side policy (`call_structured`), two blind policies for generic errors (`retry_all`, `no_retry`), `run_subtask` (local recovery + propagation with partial results), and `wasted_retries` (counted from the backend's ground-truth log) |
| `python/recovery_demo.py`, `typescript/recoveryDemo.ts` | Six scenarios x three strategies, the wire shape of an error, the report propagated to the coordinator, and a wasted-retry summary |
| `python/agent_explains.py`, `typescript/agentExplains.ts` | A Claude loop using the server's tools. With structured errors the customer hears the real reason. With generic errors the model retries a policy refusal and blames "technical problems" |

Offline, Python calls the real server in-process (`await server.call_tool(...)` returns genuine
`CallToolResult` objects). TypeScript calls the exported handler functions that the `McpServer` registers.

## Run it

```bash
python "D2.2 - Structured Error Responses for MCP Tools/python/recovery_demo.py"
python "D2.2 - Structured Error Responses for MCP Tools/python/agent_explains.py"
npx tsx "D2.2 - Structured Error Responses for MCP Tools/typescript/recoveryDemo.ts"
npx tsx "D2.2 - Structured Error Responses for MCP Tools/typescript/agentExplains.ts"

# the model reacting to real MCP results (costs tokens)
python "D2.2 - Structured Error Responses for MCP Tools/python/agent_explains.py" --live
```

Expected offline output (abridged):

```
--- Scenario 1 flaky order service ---
  structured         -> recovered     calls=3 wasted_retries=0
      attempt lookup_order({'order_id': 'ORD-1001'}) -> transient  wait 1s and retry
      attempt lookup_order({'order_id': 'ORD-1001'}) -> transient  wait 1s and retry
      attempt lookup_order({'order_id': 'ORD-1001'}) -> ok
  generic+no_retry   -> unresolved    calls=1 wasted_retries=0
--- Summary ---
  scenario                structured                generic+retry_all         generic+no_retry
  1 flaky order service   recovered calls=3         recovered calls=3         unresolved calls=1
  2 refund over policy    business_rule calls=1     unresolved calls=3        unresolved calls=1
  3 malformed order id    input_fixed calls=2       unresolved calls=3        unresolved calls=1
  4 search, no matches    ok calls=1                unresolved calls=3        unresolved calls=1
  5 corporate refund      escalate calls=1          unresolved calls=3        unresolved calls=1
  6 KB outage mid-task    unresolved calls=4        unresolved calls=4        unresolved calls=2
  wasted retries          0                         8                         0
  [PASS] wasted retries: structured 0 vs generic+retry_all 8
```

With generic errors the agent can only guess. Retrying everything wastes 8 calls on permanent
failures. Retrying nothing wastes none, but loses the timeout it could have survived. Only the
structured envelope lets it do both right.

## Register the server in Claude Code

Project scope (`.mcp.json` at the repo root, committed so the team gets it):

```json
{
  "mcpServers": {
    "support-tools": {
      "command": "python",
      "args": ["D2.2 - Structured Error Responses for MCP Tools/python/support_server.py", "--serve"]
    }
  }
}
```

Or from the CLI: `claude mcp add --scope project --transport stdio support-tools -- python "D2.2 - Structured Error Responses for MCP Tools/python/support_server.py" --serve`.
Use the venv's interpreter (or an absolute path) as the command so `mcp` is importable.
The TypeScript server runs the same way with `"command": "npx", "args": ["tsx", ".../typescript/supportServer.ts", "--serve"]`.
The tools appear to Claude as `mcp__support-tools__process_refund` and so on. More on scopes is in [D2.4](<../D2.4 - MCP Server Integration with Claude Code and Agents/README.md>).

## Error category reference

| Category | Example here | `isRetryable` | Agent action | Extra fields |
|---|---|---|---|---|
| transient | order service timeout, KB 503 | true | wait, then retry the same call | `retryAfterSeconds` |
| validation | `order_id` "#1002" | false | correct the input from `details`, or ask the user | `details.field`, `expected_format`, `received` |
| business | refund $900 > $500 limit | false | explain with `customerMessage`, offer the alternative | `customerMessage`, `details.policy` |
| permission | corporate refund without `refunds:corporate` | false | escalate to someone with access | `details.required_scope` |
| *(not an error)* | search with 0 matches | n/a | answer "nothing found" or rephrase | `matched: 0` |

## Exam traps

- **"Operation failed" for everything** is the anti-pattern the exam names. It forces a blind choice: retry everything and waste calls, or retry nothing and give up on recoverable timeouts. In `agent_explains`, the generic server also makes the agent *tell the customer the wrong reason*.
- **Empty is not failed.** A search with no matches is a successful query. Marking it `isError` (or, the reverse, returning an empty success when the KB was actually unreachable) breaks the agent's retry decisions. Sample Q8 option C is the same mistake one level up: "return an empty result set marked as successful" on a timeout.
- **Recover locally, propagate the rest.** Transient retries belong inside the subagent. The coordinator should only see what the subagent couldn't fix, along with the partial results, the attempts, and the error category, so it can choose an alternative. Sample Q8 explains why a generic "search unavailable" after silent retries (option B) is wrong. [D5.3](<../D5.3 - Error Propagation Across Multi-Agent Systems/README.md>) covers propagation across agents.
- Business errors carry two messages. `message` tells the *agent* what happened and what to do. `customerMessage` is safe to say to the *customer*. Don't make the model reverse-engineer a customer explanation from a stack trace.
- `isError` is the MCP protocol flag. The envelope lives in the content. Python `MCPServer` turns an unexpected exception into a generic "Error executing tool ..." message, so classify failures yourself and return a `CallToolResult` with `is_error=True` (or raise `ToolError` with your own message).

## SDK notes

- mcp 2.x for Python renamed `FastMCP` to **`MCPServer`** (`from mcp.server import MCPServer`). The `@server.tool(description=...)` and `server.run()` (stdio) APIs work as before. Parameter descriptions come from `Annotated[str, Field(description=...)]`.
- TypeScript uses `@modelcontextprotocol/sdk` **v1** (`McpServer.registerTool(name, {description, inputSchema: <zod shape>}, handler)`), which is the version the Agent SDK depends on.
- In a stdio server, stdout belongs to the protocol. Never print in the `--serve` path.

## Try this next

1. Add a `rate_limited` transient case that returns `retryAfterSeconds: 30` and make the policy propagate instead of waiting when the wait exceeds a budget.
2. Give the caller the `refunds:corporate` scope (`Backend(caller_scopes=...)`) and confirm scenario 5 becomes a successful refund with no code change in the policy.
3. Run `agent_explains.py --live` with both styles and compare what the real model tells the customer.
