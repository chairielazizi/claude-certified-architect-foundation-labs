# D5.1: Manage conversation context to preserve critical information across long interactions

**Domain 5: Context Management & Reliability (15%)** · Task Statement 5.1
**Exam scenarios:** Customer Support Resolution Agent, Multi-Agent Research System

## What the exam expects

| Knowledge | Skill |
|---|---|
| Progressive summarization condenses amounts, percentages, dates and customer-stated expectations into vague text | Extract transactional facts (amounts, dates, order IDs, statuses) into a persistent "case facts" block that goes into every prompt, **outside** the summarized history |
| Multi-issue sessions blur together when they share one narrative summary | Keep structured issue data (order ID, amount, status) in a separate context layer |
| Tool results accumulate and use tokens out of proportion to their relevance (40+ fields per order lookup when 5 matter) | Trim verbose tool output to the relevant fields **before** it is appended to the history |
| "Lost in the middle": models reliably use the beginning and end of long inputs and can miss findings in the middle | Put a key-findings summary at the start of aggregated input and organise details under explicit section headers |
| The API is stateless: each request must carry the complete conversation history | Require subagents to return structured data with metadata (dates, source locations, methodology) instead of verbose reasoning when the downstream context budget is limited |

## The pattern

```
for each turn:
    extract_facts(turn) -> case_facts, issues     # BEFORE the turn can be summarized
    buffer.append(turn)
    if buffer is full: summary = summarize(summary + oldest turns)   # lossy, that's fine

request = system
        + <case_facts>     amounts, dates, order IDs, expectations      (verbatim, never summarized)
        + <open_issues>    | issue | order | amount | status |           (latest status wins)
        + <conversation_summary>                                        (narrative only)
        + recent turns verbatim + new user message                      (full history, every request)

tool executor:  result = trim(result, RELEVANT_FIELDS[tool])  ->  append    # not after
aggregation:    "## Key findings" (top-N by relevance, cited)  then  "### <source>" sections
```

## Files

| File | What it shows |
|---|---|
| `fixtures/support_conversation.json` | An 18-turn, 3-issue support session with chit-chat between the issues |
| `fixtures/order_lookup.json` | A realistic 47-field order record (template + per-order overrides) |
| `fixtures/subagent_findings.json` | Four research subagents' output, both as verbose reports and as structured facts with citations |
| `python/context_layers.py`, `typescript/contextLayers.ts` | `CaseFacts`, `IssueLayer`, fact extraction, prompt assembly, and the scripted summarizer/agent |
| `python/case_facts.py`, `typescript/caseFacts.ts` | Same summarizer, two pipelines. Tracks which critical facts are still in the prompt after each of 4 summarization rounds |
| `python/stateless_history.py`, `typescript/statelessHistory.ts` | Full history on every request (1, 3, 5 messages) vs sending only the newest message |
| `python/tool_output_trimming.py`, `typescript/toolOutputTrimming.ts` | A 4-order returns session with full vs trimmed `lookup_order` results; measures chars and ~tokens re-sent |
| `python/upstream_structured_outputs.py`, `typescript/upstreamStructuredOutputs.ts` | Verbose vs structured subagent reports packed into a 6,000-char synthesis budget (live mode uses `output_config` structured outputs) |
| `python/position_aware_aggregation.py`, `typescript/positionAwareAggregation.ts` | Naive concatenation vs key-findings-first with section headers, read by a simulated positional reader |

## Run it

```bash
python "D5.1 - Preserving Critical Context in Long Interactions/python/case_facts.py"
python "D5.1 - Preserving Critical Context in Long Interactions/python/stateless_history.py"
python "D5.1 - Preserving Critical Context in Long Interactions/python/tool_output_trimming.py"
python "D5.1 - Preserving Critical Context in Long Interactions/python/upstream_structured_outputs.py"
python "D5.1 - Preserving Critical Context in Long Interactions/python/position_aware_aggregation.py"
npx tsx "D5.1 - Preserving Critical Context in Long Interactions/typescript/caseFacts.ts"
# ...same names in camelCase for the other TypeScript files; add --live for the real API
```

Expected offline output (abridged):

```
--- A - naive progressive summarization ---
  after round 1: 4/6 critical facts mentioned so far are still in the prompt; lost ['2026-10-02', 'callback by Friday']
  after round 4: 2/8 critical facts mentioned so far are still in the prompt; lost ['ORD-5521', '$89.90', ...]
assistant: Here is what I can see: ORD-5602 ($129.00) is reversal issued. Anything else we discussed earlier is still in progress...
--- B - same summarizer + case facts + issues layer ---
  after round 4: 8/8 critical facts mentioned so far are still in the prompt
assistant: Here is where everything stands: ORD-5521 ($89.90) is refund pending; ORD-5590 ($24.50) is replacement shipped;
           ORD-5602 ($129.00) is reversal issued. And as promised, you will get a callback by Friday confirming the refund.

--- Context cost over the session ---           full   trimmed
  tool-output chars re-sent over 8 requests   21,100     2,174
  saved: 90% of the tool-output context
```

## Where each piece of context lives

| Context | Where | Why |
|---|---|---|
| Amounts, dates, order IDs, customer expectations ("callback by Friday") | `<case_facts>` block, every prompt | Verbatim facts must never pass through a summarizer |
| Per-issue status in a multi-issue session | `<open_issues>` table, updated in place | One row per issue; the latest status overwrites the old one |
| Narrative ("customer asked about Series 5 colours") | `<conversation_summary>` | Losing detail here is acceptable |
| The last few turns | `messages`, verbatim | Full fidelity for what is being discussed right now |
| Tool output | `tool_result`, trimmed to relevant fields | It is re-sent on every later request, so waste compounds |
| Subagent results for synthesis | Structured facts with relevance + citation; key findings first | Fits the budget, keeps provenance, avoids the middle |

## Exam traps

- **"Write a better summarization prompt."** Any summarizer eventually compresses specifics; in the demo the summary is byte-identical in both pipelines. The fix is to take the facts *out of* the summarization path, not to summarize harder.
- **Putting the case facts inside the summary.** Then they get re-summarized next round. The block lives next to the summary and is rebuilt from structured state each request.
- **One blended summary for several issues.** Statuses and amounts cross-contaminate. Use a structured issues layer keyed by issue or order, where the latest status wins.
- **Trimming after the fact.** The waste is in the history that is re-sent on every request (21,100 vs 2,174 chars here). Trim in the executor, or in a PostToolUse hook (`updatedToolOutput`, see [D1.5](<../D1.5 - Agent SDK Hooks for Interception and Normalization/README.md>)), before appending. Trim per task: keep every field the task actually needs.
- **Lost in the middle is fixed by structure, not repetition.** Lead with a key-findings summary and use explicit section headers. Do not bury the most important result in the third of five concatenated reports.
- **The API is stateless.** Sending only the newest message ("the server remembers") breaks the very next turn. The Agent SDK and Claude Code sessions resend history for you; with the raw Messages API you do it. See [D1.7](<../D1.7 - Session State Resumption and Forking/README.md>).
- **Fix the producer, not the consumer.** When the synthesis agent's budget is small, change the upstream subagents to return structured facts with citations and relevance scores instead of their reasoning chains.

## Try this next

1. Change `BUFFER_LIMIT` to 4 and `SUMMARIZE_BATCH` to 2. Watch the naive pipeline lose facts even faster while the case-facts pipeline is unchanged.
2. Add a fourth issue where the customer changes their mind ("actually, make ORD-5590 a refund"). Confirm the issues layer shows only the new status.
3. Run `position_aware_aggregation.py --live` and ask the real model for the *top three* drivers from each input. Compare which fact ids it cites.
