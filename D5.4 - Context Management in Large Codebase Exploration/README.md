# D5.4: Manage context effectively in large codebase exploration

**Domain 5: Context Management & Reliability (15%)** · Task Statement 5.4
**Exam scenarios:** Developer Productivity with Claude, Code Generation with Claude Code

## What the exam expects

| Knowledge | Skill |
|---|---|
| Context degradation in long sessions: answers become inconsistent and refer to "typical patterns" instead of the specific classes found earlier | Keep a scratchpad file of key findings and consult it for later questions |
| Scratchpad files persist key findings across context boundaries | Spawn subagents for specific investigations ("find all test files", "trace refund flow dependencies") while the main agent keeps high-level coordination |
| Subagent delegation isolates verbose exploration output | Summarize one phase's key findings before spawning the next phase's subagents, and inject that summary into their initial context |
| Structured state persistence for crash recovery: each agent exports state to a known location; the coordinator loads a manifest on resume | Design crash recovery with state exports and a manifest the coordinator loads and injects into agent prompts; use `/compact` when verbose discovery fills the context |

## The pattern

```
scratchpad    findings -> append_scratchpad(".lab-runtime/scratchpad.md")      exact names, paths, constants
              new context / after /compact -> read_scratchpad FIRST, then answer

delegation    main agent: spawn_subagent("find all test files") + spawn_subagent("trace refund flow")  (one turn)
              each subagent: fresh context, glob/grep/read 6-10 files -> returns a ~1 KB summary
              main context holds the summaries, not the files

phases        phase-1 summaries -> "Phase 1 key findings: ..." -> top of the phase-2 subagent's prompt

recovery      .lab-runtime/state/<agent>.json   {agent, status, findings, examined}   written on every step
              .lab-runtime/manifest.json         {run_id, agents: [{name, status, state_path}]}
              resume: load manifest -> skip "completed" -> rerun "running" -> inject saved findings into prompts
```

## Files

| File | What it shows |
|---|---|
| `fixtures/shop-repo/` | An 18-file storefront repo with non-obvious names (`CreditReversalService`, `ReturnEligibilityGate`, `RETURN_WINDOW_DAYS = 45`) so "typical pattern" answers are visibly wrong |
| `python/explorer.py`, `typescript/explorer.ts` | Read-only glob/grep/read tools, scratchpad tools, an agent loop that counts tool-output chars, and scripted explorer, analyst, reviewer and compactor models |
| `python/scratchpad_memory.py`, `typescript/scratchpadMemory.ts` | Two context windows split by compaction, with and without a scratchpad |
| `python/subagent_delegation.py`, `typescript/subagentDelegation.ts` | Inline vs delegated exploration (main-context size), then phase 2 with and without the injected phase-1 summary |
| `python/crash_recovery.py`, `typescript/crashRecovery.ts` | Four agents, state exports and a manifest; a crash mid-run, then resume by a fresh coordinator |
| `python/sdk_explore_agent.py`, `typescript/sdkExploreAgent.ts` | The same delegation with the Agent SDK: an Explore-style `AgentDefinition` limited to Read/Grep/Glob (config offline, real run with `--live`) |

## Run it

```bash
python "D5.4 - Context Management in Large Codebase Exploration/python/scratchpad_memory.py"
python "D5.4 - Context Management in Large Codebase Exploration/python/subagent_delegation.py"
python "D5.4 - Context Management in Large Codebase Exploration/python/crash_recovery.py"
python "D5.4 - Context Management in Large Codebase Exploration/python/sdk_explore_agent.py"
npx tsx "D5.4 - Context Management in Large Codebase Exploration/typescript/crashRecovery.ts"
python "D5.4 - Context Management in Large Codebase Exploration/python/sdk_explore_agent.py" --live   # needs the Claude Code runtime
```

Expected offline output (abridged):

```
--- A - no scratchpad ---
compacted summary: Explored 9 source files (api, notifications, orders, payments, policies) ...
  A: Typically a RefundPolicy class in the service layer enforces the refund window, usually 30 days.
--- B - scratchpad at .lab-runtime/scratchpad.md ---
window 2: tools ['read_scratchpad'], 1,070 chars of tool output
  A: ReturnEligibilityGate in src/policies/eligibility_gate.py enforces it: RETURN_WINDOW_DAYS = 45 (days since delivery).

main agent: 16 tool calls, 5,606 chars of tool output in the MAIN context          (inline)
main agent: ['spawn_subagent', 'spawn_subagent'], 1,509 chars in the MAIN context  (delegated)
  with summary:    tools ['read_file', 'read_file']
  without summary: tools ['grep', 'read_file', 'glob', 'read_file', 'read_file', 'read_file', 'read_file', 'read_file']

  CRASH: process died while notification_flow was running. All in-memory state is gone.
  skip  test_inventory     completed; findings loaded from .lab-runtime/state/test_inventory.json
  rerun notification_flow  prompt 1,751 chars
```

Runtime files (`scratchpad.md`, `manifest.json`, `state/*.json`) are written under this lab's `.lab-runtime/` (gitignored) and recreated on every run.

## Claude Code equivalents

| Lab mechanism | In Claude Code / the Agent SDK |
|---|---|
| `spawn_subagent` with a read-only explorer | The built-in **Explore** subagent, or a custom one in `.claude/agents/<name>.md` (`tools: Read, Grep, Glob`); in the SDK an `AgentDefinition` plus `"Agent"` in `allowed_tools` |
| Compaction between windows | `/compact [instructions]` when verbose discovery fills the context (e.g. `/compact keep exact class names and file paths`); `/context` shows usage |
| Scratchpad file | Any notes file the agent is told to maintain and re-read (for example `NOTES.md` referenced from `CLAUDE.md`) |
| Manifest + state files | Your orchestration code; the SDK's `resume` / `fork_session` restore a conversation, not your multi-agent bookkeeping (see [D1.7](<../D1.7 - Session State Resumption and Forking/README.md>)) |

## Exam traps

- **"Typical patterns" is the symptom.** When answers start citing what code *usually* looks like rather than the classes found earlier, context has degraded. The fix is persisted findings (a scratchpad), not a longer prompt or "try harder" instructions.
- **Compaction is lossy by design.** `/compact` keeps the gist, so exact names, paths and numbers must live somewhere that survives it. In the demo the compacted summary was accurate in spirit and useless for the follow-up question.
- **Subagents start fresh.** A subagent does not inherit the parent's history, so the task prompt (or the injected phase summary) must contain what it needs. Without the phase-1 summary, the phase-2 agent spent 8 tool calls rediscovering what was already known.
- **Delegate verbose work, keep coordination in the main agent.** The main context should hold summaries (here 1.5 KB) rather than every file read (5.6 KB, and growing with the repo). Independent investigations can be spawned in one turn.
- **Crash recovery needs structured state at known locations.** A manifest with per-agent status and state paths lets a fresh coordinator skip completed work and inject saved findings. Resuming the conversation alone does not tell you which agents finished.
- Write state *before* the step that can fail (the demo exports progress after every tool call), so a crash loses at most the step in flight.

## Try this next

1. Run `scratchpad_memory.py --live` with a third question in window 2 ("What is the AcmePay timeout?"). Check that the real model answers from the scratchpad (`TIMEOUT_SECONDS = 10`) without re-reading `acmepay_client.py`.
2. Crash inside `refund_flow` instead (`crash_in="refund_flow"`). Confirm only `test_inventory` is skipped on resume and that `notification_flow` still receives its findings.
3. Add a `.claude/agents/explorer.md` to `fixtures/shop-repo` with `tools: Read, Grep, Glob` and ask Claude Code to use it for "find all test files".
