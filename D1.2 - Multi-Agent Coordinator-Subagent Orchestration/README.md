# D1.2: Orchestrate multi-agent systems with coordinator-subagent patterns

**Domain 1: Agentic Architecture & Orchestration (27%)** · Task Statement 1.2
**Exam scenarios:** Multi-Agent Research System

## What the exam expects

| Knowledge | Skill |
|---|---|
| Hub-and-spoke: the coordinator handles all communication between subagents, plus error handling and information routing | Route every subagent call through the coordinator so you get observability, consistent error handling and controlled information flow |
| Subagents run with isolated context. They do **not** inherit the coordinator's conversation history | Write everything a subagent needs into its task. Each call is a fresh conversation |
| The coordinator decomposes the task, delegates, aggregates results, and decides which subagents a query needs | Analyse the query and pick subagents dynamically instead of always running the full pipeline |
| A decomposition that is too narrow leaves gaps in coverage of a broad topic | Partition scope (distinct subtopics, distinct source types) to avoid duplication. Run an iterative refinement loop: synthesis reports gaps, the coordinator re-delegates targeted queries, then synthesis runs again until coverage is sufficient |

## The pattern

```
                 +-------------------- coordinator ---------------------+
 query --------> | plan(): complexity? which subagents? which slices?  |
                 | validate_coverage(plan) ---- fails -> re-plan        |
                 |                                                      |
                 | delegate(role, task)   <- the ONLY way to reach a    |
                 |   - fresh messages=[task]  subagent: isolation,      |
                 |   - event log              logging and one error     |
                 |   - one error policy       policy live here          |
                 +---+-----------+--------------+---------------+-------+
                     |           |              |               |
                web_search  document_analysis  synthesis      report
               (news, web)  (reports, papers)  -> key points  -> final text
                                               -> coverage_gaps[]
 simple fact:  plan -> web_search -> answer
 broad topic:  plan -> validate -> {web_search, document_analysis} per slice
               -> loop: synthesis -> gaps? -> targeted re-delegation   (bounded; raise if not converging)
               -> report
```

Each subagent is a separate `messages.create` call with its own system prompt and a **one-message** conversation. The coordinator's own planning history is never sent.

## Files

| File | What it shows |
|---|---|
| `python/research_team.py`, `typescript/researchTeam.ts` | Role prompts, JSON output schemas (sent as `output_config.format` in live mode), a fictional corpus, and **one scripted responder for every role**. It dispatches on the system prompt's role tag and can only use the task text it receives |
| `python/coverage_validator.py`, `typescript/coverageValidator.ts` | The coverage checklist and `validate_coverage()`. It reports which required dimensions are **missing** and which ones several slices **overlap** on, then turns that into feedback for the coordinator |
| `python/coordinator.py`, `typescript/coordinator.ts` | The `Coordinator` (plan, delegate, gather, refine, research) and its event log. It runs a simple factual query and a broad topic so you can compare the two routes. Checks prove every subagent request was isolated |
| `python/scope_partitioning.py`, `typescript/scopePartitioning.ts` | Sample question 7 reproduced: the visual-arts-only decomposition, the validator flagging music, writing and film, the re-plan built from that feedback, and the final slice x source-type partition |
| `python/refinement_loop.py`, `typescript/refinementLoop.ts` | Failure injection (always offline). A one-off timeout is recovered through the gap loop. A source that stays down hits the round bound and raises `CoverageNotConverged` |

## Run it

```bash
# from the repo root
python "D1.2 - Multi-Agent Coordinator-Subagent Orchestration/python/coordinator.py"
python "D1.2 - Multi-Agent Coordinator-Subagent Orchestration/python/scope_partitioning.py"
python "D1.2 - Multi-Agent Coordinator-Subagent Orchestration/python/refinement_loop.py"
npx tsx "D1.2 - Multi-Agent Coordinator-Subagent Orchestration/typescript/coordinator.ts"
npx tsx "D1.2 - Multi-Agent Coordinator-Subagent Orchestration/typescript/scopePartitioning.ts"
npx tsx "D1.2 - Multi-Agent Coordinator-Subagent Orchestration/typescript/refinementLoop.ts"

# against the real API (every role becomes a real messages.create call; costs tokens)
python "D1.2 - Multi-Agent Coordinator-Subagent Orchestration/python/coordinator.py" --live
```

Expected offline output (abridged):

```
--- A - simple factual query ---
route chosen by the coordinator: ['web_search']   refinement rounds: 0
  01 plan     coordinator       plan-1     simple; route=['web_search']; 1 slice(s)
  02 delegate web_search        q1/web     When did the EU AI Act enter into force?
  03 result   web_search        q1/web     1 finding(s)
  [PASS] simple factual query -> web_search only (1 subagent call, no synthesis or report)
--- B - broad research topic ---
route chosen by the coordinator: ['web_search', 'document_analysis', 'synthesis', 'report']   refinement rounds: 2
  18 result   document_analysis st4/docs   0 finding(s)
  20 result   synthesis         synth-r1   4 key point(s), 1 gap(s), sufficient=False
  21 refine   coordinator       round-1    film: no document evidence -> document_analysis
  22 delegate document_analysis gap-r1.1   AI in visual effects (VFX) and animation: workforce studies
  25 result   synthesis         synth-r2   4 key point(s), 0 gap(s), sufficient=True
  [PASS] every subagent call was a fresh 1-message conversation with no coordinator history
  [PASS] synthesis reported a gap in round 1; the targeted follow-up closed it in round 2
```

## Routing and coverage at a glance

| Query | Coordinator decision | Subagent calls |
|---|---|---|
| "When did the EU AI Act enter into force?" | `simple`: one verifiable fact | 1 (`web_search`) |
| "impact of AI on creative industries" | `broad`: 4 sector slices x 2 source types, then synthesis and report | 8 research + 1 targeted follow-up + 2 synthesis + 1 report |

| Decomposition | `missing` | `overlaps` |
|---|---|---|
| Q7: digital art / graphic design / photography | music, writing, film | visual_arts: st1, st2, st3 |
| Repaired: visual arts / music / writing+publishing / film+video | none | none |

## Exam traps

- **Sample Q7 (narrow decomposition).** The report covers only visual arts, and the coordinator's log shows the subtasks "digital art", "graphic design" and "photography". The root cause is **the coordinator's decomposition (B)**. It is not the synthesis agent (A), the search queries (C) or the document filter (D). Those agents did their assigned work correctly. Fix it where the decision is made: validate the decomposition against the topic's dimensions before delegating.
- **"Subagents share the coordinator's memory."** They don't. A subagent sees its system prompt and the task message. Anything else, such as the topic, the slice, prior findings or constraints, must be written into that task. The `isolation_violations` check proves no request carried coordinator history.
- **"Always run the full pipeline."** That is wasteful. A factual lookup needs one search. The coordinator should choose subagents based on query complexity.
- **Subagents calling each other directly.** That breaks observability and error handling. In hub-and-spoke, results return to the coordinator, which logs them, handles failures in one place and decides what flows where.
- **Unbounded refinement, or silently publishing partial coverage.** Bound the loop. If coverage doesn't converge, raise or annotate the gap. Don't present a holey report as complete. (Structured error propagation is covered in depth in [D5.3](<../D5.3 - Error Propagation Across Multi-Agent Systems/README.md>).)
- **Sample Q9 (synthesis needs fact checks).** The right answer is a scoped `verify_fact` tool for the synthesis agent covering the 85% of simple lookups, while complex checks still go through the coordinator. That is least privilege. Giving synthesis every search tool, or batching all checks to the end, are the distractors.

## SDK notes

- This lab builds hub-and-spoke on the **Messages API** so every request is visible. The Claude Agent SDK provides the same pattern through the `Agent` tool (formerly `Task`) and `AgentDefinition`s. See [D1.3](<../D1.3 - Subagent Invocation Context Passing and Spawning/README.md>), which also covers spawning subagents in parallel.
- Live mode sends each role's schema as `output_config={"format": {"type": "json_schema", "schema": ...}}`, so replies are valid JSON. The subagents have **no browsing tool** in this lab, so live "sources" come from the model's memory and must not be trusted. In production, attach real search or document tools (Domain 2).
- The corpus, documents and statistics are fictional and exist only for the offline demo.

## Try this next

1. Add a fifth dimension (`games`) to the checklist in `coverage_validator.py` and run `coordinator.py`. The validator rejects the 4-slice plan on every attempt, and planning stops after `MAX_PLAN_ATTEMPTS`. Add a games slice to `CREATIVE_SUBTOPICS`, plus corpus entries, until the run passes.
2. Give the synthesis role a scoped `verify_fact` tool (sample Q9). Let it resolve simple date checks itself, and have it return `coverage_gaps` only for deeper questions.
3. Make `delegate()` retry once on `retryable` errors before logging the failure. Compare the event log of `refinement_loop.py` scenario A with and without the retry.
