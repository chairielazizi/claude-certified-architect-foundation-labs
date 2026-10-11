# D2.3: Distribute tools appropriately across agents and configure tool choice

**Domain 2: Tool Design & MCP Integration (18%)** · Task Statement 2.3
**Exam scenarios:** Multi-Agent Research System, Structured Data Extraction

## What the exam expects

| Knowledge | Skill |
|---|---|
| Too many tools on one agent (18 instead of 4-5) degrades selection reliability by adding decision complexity | Restrict each subagent's tools to its role, so specialists can't misuse each other's tools |
| Agents with tools outside their specialization misuse them (a synthesis agent running web searches) | Replace generic tools with constrained ones (`fetch_url` becomes `load_document`, which validates document URLs) |
| Scoped access: only the role's tools, plus limited cross-role tools for specific high-frequency needs | Give a scoped cross-role tool for the common case (`verify_fact` for synthesis) and route complex cases through the coordinator |
| `tool_choice` options: `"auto"`, `"any"`, forced `{"type": "tool", "name": "..."}` | Force a specific first tool (`extract_metadata` before enrichment), then handle later steps in follow-up turns. Use `"any"` to guarantee a tool call instead of a text reply |

## The pattern

```
coordinator ("Agent" tool only)
 ├─ web_search_agent        [web_search, load_document]           <- load_document, not fetch_url
 ├─ document_analysis_agent [extract_data_points, summarize_content]
 ├─ synthesis_agent         [verify_fact]                         <- scoped cross-role tool (Q9)
 │       simple fact (date/name/number) -> verify_fact, in-agent
 │       complex claim                  -> back to coordinator -> web_search_agent
 └─ report_agent            [format_report]

turn 1:  tool_choice {"type": "tool", "name": "extract_metadata"}   guaranteed first step
turn 2+: tool_choice {"type": "auto"}                               model picks enrichment tools
```

## Files

| File | What it shows |
|---|---|
| `python/tool_registry.py`, `typescript/toolRegistry.ts` | The 18-tool catalog with categories, role specializations, `SCOPED_CONFIG` vs `EVERYTHING_CONFIG`, documented cross-role allowances, and `check_distribution` (warns when an agent has > 6 tools or tools outside its role) |
| `python/distribution_check.py`, `typescript/distributionCheck.ts` | The checker run on the scoped config, the 18-tool config, and Q9 option C. Also verification routing: 17/20 claims go to `verify_fact`, so coordinator round trips drop from 40 to 6 |
| `python/constrained_tools.py`, `typescript/constrainedTools.ts` | `load_document` URL validation (https, allowlist, no IP literals, no credentials, document extensions, no `..`) with 13 test cases, compared with the unchecked `fetch_url` |
| `python/tool_choice_demo.py`, `typescript/toolChoiceDemo.ts` | Request builders for `auto` / `any` / `tool` / `none`, a forced first step followed by `auto`, and the modern alternative on `lab.MODEL` (`auto` + `strict` + instruction + verify/re-prompt) |

## Run it

```bash
python "D2.3 - Tool Distribution and tool_choice Configuration/python/distribution_check.py"
python "D2.3 - Tool Distribution and tool_choice Configuration/python/constrained_tools.py"
python "D2.3 - Tool Distribution and tool_choice Configuration/python/tool_choice_demo.py"
npx tsx "D2.3 - Tool Distribution and tool_choice Configuration/typescript/toolChoiceDemo.ts"

# real API: forced/any go to LAB_FORCED_TOOL_MODEL (default claude-opus-5)
python "D2.3 - Tool Distribution and tool_choice Configuration/python/tool_choice_demo.py" --live
```

Expected offline output (abridged):

```
--- 1. Same conversational message, four tool_choice settings ---
  {"type": "auto"}                              model=claude-opus-5-5  stop_reason=end_turn content=['text']
  {"type": "any"}                               model=claude-opus-5    stop_reason=tool_use content=['tool_use:extract_metadata']
  {"type": "tool", "name": "extract_metadata"}  model=claude-opus-5    stop_reason=tool_use content=['tool_use:extract_metadata']
  {"type": "none"}                              model=claude-opus-5-5  stop_reason=end_turn content=['text']
--- 2a. auto on every turn ---
  tool order: ['lookup_citations (error)', 'extract_metadata', 'lookup_citations', 'lookup_author_affiliations']
--- 2b. forced extract_metadata first, then auto ---
  tool order: ['extract_metadata', 'lookup_citations', 'lookup_author_affiliations']
  tool_choice per turn: ['tool', 'auto', 'auto']
--- 3. Modern alternative on claude-opus-5-5: auto + strict + instruction + verify ---
  extract_metadata came back on attempt 2
```

## tool_choice reference

| Setting | Guarantee | Use it for | Watch out |
|---|---|---|---|
| `{"type": "auto"}` (default) | none: tool call *or* text | normal agent turns | the model may skip a step or answer in text |
| `{"type": "any"}` | some tool is called | turns that must produce a tool call (structured output via tools) | it forces a call even for "thanks!" (demo 1), with invented arguments |
| `{"type": "tool", "name": "X"}` | exactly X is called | a mandatory first step (`extract_metadata`), structured extraction | force only the step that needs it. Follow-ups go back to `auto` |
| `{"type": "none"}` | no tool call | a final summary turn | |

## Exam traps

- **Sample Q9** (synthesis needs fact checks; 85% simple, 15% complex): the answer is **A, a scoped `verify_fact` tool for simple lookups**, with complex verifications still delegated through the coordinator. That is least privilege for the common case, and coordination stays in place for the hard case. The distractors:
  - Batching verifications (B) creates blocking dependencies.
  - Giving synthesis all web tools (C) over-provisions it. The checker flags it.
  - Speculative caching (D) can't predict what synthesis will need.
- More tools is not more capability. Each extra tool is another option at every step. The 18-tool config also sends roughly 15x more tool-definition text on every turn.
- A cross-role tool should be **narrow** (one simple fact against a reference index) and **documented** (why this role needs it). It is not a back door to the specialist's whole toolset.
- Replacing `fetch_url` with `load_document` is about **constraining inputs** to what the role legitimately needs. Validation failures go back as structured, non-retryable errors (see [D2.2](<../D2.2 - Structured Error Responses for MCP Tools/README.md>)).
- `tool_choice: any` guarantees *a* tool call, not *the right* one. `{"type": "tool"}` guarantees which one, but only for that turn. Run the remaining steps in follow-up turns with `auto`.
- For writing descriptions that make the right tool obvious within a role, see [D2.1](<../D2.1 - Tool Interface Design with Clear Descriptions/README.md>).

## SDK notes

- **Forced tool choice drift:** `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1` return HTTP 400 for `tool_choice` `any` / `tool`. The concept is still on the exam. `build_request` sends forced choices to `lab.FORCED_TOOL_CHOICE_MODEL` (`LAB_FORCED_TOOL_MODEL`, default `claude-opus-5`). The forced pipeline in demo 2 keeps the whole conversation on that model rather than switching mid-conversation.
- **Modern alternative on current models:** use `tool_choice: auto`, mark the tool `"strict": true` (schema needs `additionalProperties: false` and `required`), name the tool in the instructions, and **verify** a matching `tool_use` came back. If it didn't, append the assistant turn and re-prompt (`call_until_tool`). For pure structured output, `output_config.format` JSON schema is the other option (see [D4.3](<../D4.3 - Structured Output with Tool Use and JSON Schemas/README.md>)).
- With forced tool choice the response has no text preamble before the `tool_use` block.
- In the Agent SDK the same scoping is `AgentDefinition(tools=[...])` per subagent, with `"Agent"` (formerly `"Task"`) on the coordinator. See [D1.3](<../D1.3 - Subagent Invocation Context Passing and Spawning/README.md>).

## Try this next

1. Add `generate_chart` to `report_agent` and `deep_verify_claim` to `synthesis_agent`. Which one should the checker accept, and what allowance text would justify it?
2. Add an allowlisted domain with a tricky look-alike (`who.int.example.net`) to the URL cases and confirm the suffix rule rejects it.
3. Run `tool_choice_demo.py --live` and compare the real model's first tool under `auto` with the forced pipeline.
