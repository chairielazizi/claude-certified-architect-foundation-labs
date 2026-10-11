# D2.4: Integrate MCP servers into Claude Code and agent workflows

**Domain 2: Tool Design & MCP Integration (18%)** · Task Statement 2.4
**Exam scenarios:** Developer Productivity with Claude, Code Generation with Claude Code, Customer Support Resolution Agent

## What the exam expects

| Knowledge | Skill |
|---|---|
| MCP server scoping: project-level `.mcp.json` for shared team tooling, user-level `~/.claude.json` for personal or experimental servers | Configure shared servers in project-scoped `.mcp.json`, with environment variable expansion for auth tokens |
| Environment variable expansion in `.mcp.json` (`${GITHUB_TOKEN}`) manages credentials without committing secrets | Configure personal or experimental servers in user-scoped `~/.claude.json` |
| Tools from all configured MCP servers are discovered at connection time and available at the same time | Write MCP tool descriptions that explain capabilities and outputs in detail, so the agent doesn't fall back to built-in tools like Grep |
| MCP resources can expose content catalogs (issue summaries, documentation hierarchies, database schemas) that cut exploratory tool calls | Choose existing community servers for standard integrations (Jira). Build custom servers only for team-specific workflows. Expose catalogs as resources |

## The pattern

```
example-project/.mcp.json  (project scope, committed)
  github         type http   Authorization: Bearer ${GITHUB_TOKEN}     existing vendor server
  issue-tracker  type http   url: ${JIRA_MCP_URL}                      existing community/vendor server (example)
  team-kb        stdio       python servers/team_kb_server.py          custom: team-specific data
                             env KB_TOKEN=${KB_TOKEN}, KB_URL=${KB_URL:-http://localhost:8080}

~/.claude.json  (user / local scope, never committed)
  mcpServers.scratch-notes                       personal, every project
  projects["/path/to/repo"].mcpServers.<name>    personal, this project only (local scope)

at connection time -> one tool list:  mcp__github__*, mcp__issue-tracker__*, mcp__team-kb__*
team-kb resources  -> catalog://issues/summary, catalog://docs/hierarchy, catalog://db/schema
```

## Files

| File | What it shows |
|---|---|
| `example-project/.mcp.json` | Project-scoped config: two standard integrations (remote http) and the custom team server (stdio). Every credential is a `${VAR}` reference |
| `example-project/servers/team_kb_server.py` | The custom server (Python `MCPServer`, mcp 2.x). Four tools with detailed descriptions (what the data is, where it lives, what comes back, why not Grep) and three catalog resources. stdio only with `--serve` |
| `user-scope-example/claude.json` | The `mcpServers` part of `~/.claude.json`: a user-scope server, plus a local-scope entry under `projects` |
| `python/kb_server_demo.py`, `typescript/kbServerDemo.ts` | In-process `list_tools` / `list_resources` / `read_resource` (TS calls the handlers). A catalog read beats guessing: 6 exploratory calls drop to 1, and it surfaces an open issue that tool exploration missed |
| `python/inspect_mcp_config.py`, `typescript/inspectMcpConfig.ts` | Secrets lint (the committed file is clean, a leaky variant is flagged), `${VAR}` / `${VAR:-default}` expansion against a fake env with warnings for unset vars, and the union of tools from all servers |
| `python/agent_sdk_config.py`, `typescript/agentSdkConfig.ts` | **Live only.** Agent SDK `mcp_servers` combining a stdio server config and an in-process SDK server. Prints the init message's MCP server status. Offline it prints the options and calls the in-process tool directly |
| `typescript/teamKbServer.ts` | TypeScript twin of the custom server (`McpServer` v1 + zod, `registerTool` / `registerResource`) |

## Run it

```bash
python "D2.4 - MCP Server Integration with Claude Code and Agents/python/kb_server_demo.py"
python "D2.4 - MCP Server Integration with Claude Code and Agents/python/inspect_mcp_config.py"
python "D2.4 - MCP Server Integration with Claude Code and Agents/python/agent_sdk_config.py"          # prints config
python "D2.4 - MCP Server Integration with Claude Code and Agents/python/agent_sdk_config.py" --live   # real agent
npx tsx "D2.4 - MCP Server Integration with Claude Code and Agents/typescript/inspectMcpConfig.ts"

# use the project config in Claude Code itself (approve the project servers when asked, then /mcp)
cd "D2.4 - MCP Server Integration with Claude Code and Agents/example-project" && claude
```

Expected offline output (abridged):

```
--- 1. Secrets lint ---
  example-project/.mcp.json: 0 finding(s)
  leaky variant:
      - github.headers.Authorization: literal credential; reference ${GITHUB_TOKEN} instead
      - team-kb.env.KB_TOKEN: literal credential; reference ${KB_TOKEN} instead
--- 2. Expansion against a fake environment ---
  issue-tracker: {"type": "http", "url": "${JIRA_MCP_URL}", ...}
      WARNING ${JIRA_MCP_URL} is not set and has no default; the literal text is kept
  team-kb: {... "env": {"KB_TOKEN": "kb-test-to****", "KB_URL": "http://localhost:8080"}}
--- 3. Servers and the tools the agent sees (all at once) ---
  union seen by the agent (11 tools): ['mcp__github__search_code', ..., 'mcp__team-kb__describe_table']
--- 3. Catalog resources vs exploratory tool calls ---        (kb_server_demo)
  without catalog: table=refund_events issues=[] tool_calls=6
  with catalog:    table=refund_events issues=['PAY-311'] tool_calls=1 resource_reads=2
```

## Which scope?

| Situation | Scope | Stored in | Shared via git? | CLI |
|---|---|---|---|---|
| Team tooling everyone needs (GitHub, the issue tracker, the team KB) | project | `.mcp.json` at the repo root | yes | `claude mcp add --transport http github --scope project https://api.githubcopilot.com/mcp/` |
| Your personal or experimental server, in every project | user | `~/.claude.json` (top-level `mcpServers`) | no | `claude mcp add --scope user --transport stdio scratch-notes -- python ~/experiments/notes_server.py --serve` |
| Your personal server for one project only | local | `~/.claude.json` under that project's path | no | `claude mcp add --scope local ...` |

For stdio servers with env vars: `claude mcp add --scope project --env KB_URL=http://localhost:8080 --transport stdio team-kb -- python servers/team_kb_server.py --serve`.
To keep `${VAR}` references (and not literal values) in a committed file, edit `.mcp.json` directly as shown above.
`${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url` and `headers`. If a variable is unset and has no default, Claude Code warns about it.

## Community server or custom server?

| Integration | Choice | Why |
|---|---|---|
| GitHub, Jira, other standard SaaS | existing community or vendor MCP server | It's already maintained and covers the API. Building your own is cost without differentiation |
| Team runbooks, ADRs, service ownership, warehouse schema | custom server (`team_kb_server.py`) | Team-specific data and workflows that no public server knows about |

The `issue-tracker` entry here is an **example** of pointing at an existing server by URL. Its
URL comes from `${JIRA_MCP_URL}`, and its tool names in the inspect script are illustrative.

## Exam traps

- **Secrets in `.mcp.json`.** The file is committed, so `"Authorization": "Bearer ghp_..."` leaks the token to everyone with repo access. Use `${GITHUB_TOKEN}` and let each developer's environment supply it.
- **Personal servers in project scope.** An experimental server in `.mcp.json` lands on every teammate's machine. Personal and experimental servers belong in `~/.claude.json` (user or local scope).
- **"The agent keeps using Grep instead of our MCP tool."** The fix is a better MCP tool *description*: what it searches, that the data isn't in the repo, what it returns, and when to prefer it. Don't remove Grep.
- **Exploratory calls to learn what exists.** A `catalog://db/schema` resource tells the agent which tables exist without a round of `describe_table` guesses. An issue-summary catalog shows things that tool searches over a different store miss entirely.
- **Rebuilding standard integrations.** Choose the existing Jira/GitHub server. Write custom servers for team-specific workflows.
- Tools from **all** configured servers are available at once, with no switching. That is also why you scope tools per agent (`allowed_tools`, see [D2.3](<../D2.3 - Tool Distribution and tool_choice Configuration/README.md>)): every server's tools add to the selection load.

## SDK notes

- Python mcp 2.x: `MCPServer` (formerly `FastMCP`), with `@server.tool(description=...)` and `@server.resource(uri, description=..., mime_type=...)`. In-process testing uses `await server.list_tools()`, `list_resources()`, `read_resource(uri)` (returns a list of `ReadResourceContents`) and `call_tool(name, args)`.
- TypeScript `@modelcontextprotocol/sdk` v1: `registerTool(name, {description, inputSchema: zodShape}, cb)` and `registerResource(name, uri, {description, mimeType}, async (uri) => ({contents: [{uri: uri.href, text}]}))`.
- Agent SDK (Python): `ClaudeAgentOptions(mcp_servers={...})` accepts stdio (`{"type": "stdio", "command", "args", "env"}`), http, sse, and SDK servers (`create_sdk_mcp_server(...)`), which can be mixed in one dict. The type annotation also accepts a path to a JSON config file, and there is a `strict_mcp_config` flag. Both come from the SDK's types and were not exercised here. `ClaudeSDKClient.get_mcp_status()` returns live per-server status.
- **Unverified offline:** the init `SystemMessage.data` keys `mcp_servers` (list of `{name, status}`) and `tools` follow the Claude Code init message. Check them with `--live`. The local-scope layout under `projects` in `user-scope-example/claude.json` reflects how `claude mcp add --scope local` stores entries. Confirm on your machine with `claude mcp list`.

## Try this next

1. Add a `catalog://services` resource listing every service with its owner, then change `find_service_owner`'s description to point at it. How many calls does "who owns search?" need now?
2. Set `JIRA_MCP_URL` in `FAKE_ENV` and give `KB_URL` a value, then re-run the inspector to watch the warnings disappear and the default stop applying.
3. Register `example-project/.mcp.json` in Claude Code, ask "why did we choose Postgres for refunds?", and check in the transcript that it calls `mcp__team-kb__search_kb` and not Grep.
