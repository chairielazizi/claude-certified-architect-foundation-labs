# D5.3: Implement error propagation strategies across multi-agent systems

**Domain 5: Context Management & Reliability (15%)** · Task Statement 5.3
**Exam scenarios:** Multi-Agent Research System

## What the exam expects

| Knowledge | Skill |
|---|---|
| Structured error context (failure type, attempted query, partial results, alternatives) is what lets the coordinator make intelligent recovery decisions | Return structured error context: failure type, what was attempted, partial results, potential alternatives |
| Access failures (timeouts needing retry decisions) differ from valid empty results (the query worked and found nothing) | Report access failures and valid empty results differently so the coordinator can act on each correctly |
| Generic statuses ("search unavailable") hide the context the coordinator needs | Recover locally from transient failures inside the subagent; propagate only what it cannot resolve, with what was attempted and the partial results |
| Silently suppressing errors (empty result marked success) and terminating the whole workflow on one failure are both anti-patterns | Structure synthesis output with coverage annotations: which findings are well-supported and which topic areas have gaps because sources were unavailable |

## The pattern

```
subagent(subtopic, source, query):
    for attempt in 1..3:
        outcome = search()
        if ok: return {status: success, results, match_count}      # match_count 0 = VALID empty result
        if outcome is transient (timeout, rate_limited): backoff 200ms, 400ms ... and retry locally
        else: break                                                 # access_denied: retrying cannot help
    return {status: partial|failed, failure_type, retryable, attempted_query,
            attempts, partial_results, alternatives: [narrow_query | alternative_source | retry_later]}

coordinator, per envelope:
    success (incl. 0 matches)        -> accept
    timeout + narrow_query offered   -> retry with the narrower query
    access_denied + other source     -> try the alternative source
    nothing fits the time budget     -> proceed with partial results, annotate the gap
synthesis: findings per subtopic + a coverage table (well-supported / gap / no published data)
```

## Files

| File | What it shows |
|---|---|
| `fixtures/research_sources.json` | The research plan and the simulated behaviour of each source and query (timeouts, rate limits, access denied, empty results) |
| `python/research_system.py`, `typescript/researchSystem.ts` | The structured subagent with local retry and backoff, three anti-pattern subagents, `decide_recovery`, the coverage-annotated synthesis, the coordinator's tools and its scripted model |
| `python/coordinator.py`, `typescript/coordinator.ts` | A Claude coordinator fans out six subtopics in one turn, reads the envelopes, recovers two failures, accepts one partial, and submits coverage |
| `python/anti_patterns.py`, `typescript/antiPatterns.ts` | Structured vs generic vs suppress vs terminate on the same run, with a report-quality table |

## Run it

```bash
python "D5.3 - Error Propagation Across Multi-Agent Systems/python/coordinator.py"
python "D5.3 - Error Propagation Across Multi-Agent Systems/python/anti_patterns.py"
npx tsx "D5.3 - Error Propagation Across Multi-Agent Systems/typescript/coordinator.ts"
npx tsx "D5.3 - Error Propagation Across Multi-Agent Systems/typescript/antiPatterns.ts"
python "D5.3 - Error Propagation Across Multi-Agent Systems/python/coordinator.py" --live    # real coordinator, simulated sources
```

Expected offline output (abridged):

```
--- Coordinator turn 1: 6 delegation(s) ---
  music        web_search       success  -             attempts: timeout(+200ms) ok
  writing      academic_db      failed   access_denied attempts: access_denied
  film         web_search       partial  timeout       attempts: timeout(+200ms) timeout(+400ms) timeout
  games        news_archive     partial  rate_limited  attempts: rate_limited(+200ms) rate_limited(+400ms) rate_limited
  architecture academic_db      success  -             attempts: ok
--- Coordinator turn 2: 2 delegation(s) ---
  writing      industry_reports success  -             attempts: ok
  film         web_search       success  -             attempts: ok
| games | gap: partial results | 1 | news_archive rate_limited after 3 attempt(s); proceeding with 1 partial result(s) |
| architecture | no published data | 0 | academic_db search succeeded with 0 matches |

--- Final report quality ---       structured     generic    suppress   terminate
  findings                              10           5           5           -
  successful recoveries                  2           0           0           -
  false 'no data' claims                 0           0           3           -
  gaps with failure detail               1           0           0           -
  report produced                      yes         yes         yes          no
```

## Failure handling at a glance

| Situation | Who handles it | What the coordinator receives |
|---|---|---|
| One timeout, then success | Subagent (local retry with backoff) | `success`, with `attempts` showing the retry |
| Repeated timeouts on a broad query | Coordinator | `partial`, `timeout`, `attempted_query`, partial results, `narrow_query` alternative |
| Access denied | Coordinator (no local retry) | `failed`, `access_denied`, alternative sources |
| Rate limited, "retry in 900 s" | Coordinator: proceed and annotate | `partial`, `rate_limited`, `retry_later` alternative |
| Query worked, zero matches | Nobody: it is a finding | `success`, `match_count: 0` |

## Exam traps

- **Sample Q8.** Structured error context (A) is correct because it gives the coordinator what it needs to choose: retry with a modified query, try an alternative, or proceed with partial results. In the demo it produced 10 findings, recovered 2 failures, and disclosed the one remaining gap with its cause.
- **Q8 B: retry internally, then return "search unavailable".** Local retry is good, but the generic status throws away the failure type, the query and the partial results. The coordinator can only retry blindly, and the blind retries failed again (0 recoveries, 5 findings).
- **Q8 C: empty result marked success.** This is the worst option because it looks like success: the report claimed "no published data" for three subtopics whose sources had actually failed, and its coverage looked complete.
- **Q8 D: terminate the workflow.** One access failure discarded the subtopics that had already succeeded and everything that could have been recovered.
- **Valid empty is not an error.** "Searched and found nothing" is a finding to report. Do not retry it, and never let a failure masquerade as it.
- **Do not retry what cannot succeed.** `access_denied` is propagated after one attempt; only transient failures get local retries, and those retries are bounded.
- The coordinator still needs a budget: one recovery per subtopic and a time limit (here 300 s) decide when to proceed with partial results instead of waiting. See [D1.2](<../D1.2 - Multi-Agent Coordinator-Subagent Orchestration/README.md>) for the coordinator-subagent structure itself.

## Try this next

1. Change the games `retry_later` to 120 seconds and re-run `coordinator.py`. The coordinator should now retry the same query instead of proceeding with partial results.
2. Make `industry_reports` also return `access_denied` for the writing query. Check that synthesis labels writing as a gap with both failures in the note.
3. Run `coordinator.py --live` and compare the real model's `submit_coverage` decisions with the scripted ones.
