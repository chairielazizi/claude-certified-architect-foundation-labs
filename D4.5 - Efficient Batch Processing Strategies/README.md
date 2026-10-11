# D4.5: Design efficient batch processing strategies

**Domain 4: Prompt Engineering & Structured Output (20%)** · Task Statement 4.5
**Exam scenarios:** Structured Data Extraction, Claude Code for Continuous Integration

## What the exam expects

| Knowledge | Skill |
|---|---|
| Message Batches API: 50% cost savings, up to 24-hour processing window, no guaranteed latency SLA | Match the API to the workflow's latency needs: synchronous for blocking pre-merge checks, batch for overnight / weekly analysis |
| Batch fits non-blocking, latency-tolerant work (overnight reports, weekly audits, nightly test generation). It does not fit blocking workflows (pre-merge checks) | Work out the submission frequency from the SLA (for example, 4-hour windows to guarantee a 30-hour SLA with 24-hour batch processing) |
| A batch request cannot do multi-turn tool calling (no executing tools mid-request and returning results) | Handle failures by resubmitting only the failed documents (identified by `custom_id`) with the right changes, such as chunking documents that exceeded the context limit |
| `custom_id` correlates batch requests with their results | Refine the prompt on a sample set before batch-processing large volumes, to raise first-pass success and cut resubmission cost |

## The pattern

```
choose_api(workflow): blocking or needs a tool loop -> synchronous ; latency-tolerant -> batch

max_window = SLA - 24h (max batch time) - buffer        # 30h - 24h - 2h = submit every 4h

1. refine the prompt on ~5 docs with the SYNC API until first-pass success is high
2. batch = batches.create(requests=[{custom_id: doc.id, params: {...}} for doc in docs])
3. poll batches.retrieve(batch.id).processing_status until "ended"
4. for r in batches.results(batch.id): by_id[r.custom_id] = r      # ANY order
5. failed = errored | expired  ->  resubmit only those:
        invalid_request (too long) -> chunk into doc-017#p1..pN, merge the parts afterwards
        expired                    -> same request again
6. elapsed (window wait + rounds) vs SLA; a resubmission round needs its own budget
```

## Files

| File | What it shows |
|---|---|
| `python/fake_batch_service.py`, `typescript/fakeBatchService.ts` | `create` / `retrieve` / `results` on a simulated clock. Seeded Mulberry32 PRNG (the same in both languages), shuffled results, context-limit errors, expirations |
| `python/batch_workload.py`, `typescript/batchWorkload.ts` | 24 generated supplier contracts (one oversized), prompts v1 and v2, the offline model, `custom_id` request builder, strict validation, chunk and merge helpers |
| `python/api_choice.py`, `typescript/apiChoice.ts` | `choose_api()` for five workflows, sample question 11, and a batched request with a tool that just ends on `tool_use` |
| `python/sla_calculator.py`, `typescript/slaCalculator.ts` | Submission window per SLA, plus a simulation that checks the worst-case latency |
| `python/sample_refinement.py`, `typescript/sampleRefinement.ts` | Sync API on a 5-document sample: v1 60% (refine), v2 100% (go) |
| `python/batch_pipeline.py`, `typescript/batchPipeline.ts` | The full run: submit, poll, correlate by `custom_id`, resubmit only failures (chunking the oversized one), merge, SLA check. `--live` sends a tiny real batch |

## Run it

```bash
python "D4.5 - Efficient Batch Processing Strategies/python/api_choice.py"
python "D4.5 - Efficient Batch Processing Strategies/python/sla_calculator.py"
python "D4.5 - Efficient Batch Processing Strategies/python/sample_refinement.py"
python "D4.5 - Efficient Batch Processing Strategies/python/batch_pipeline.py"
npx tsx "D4.5 - Efficient Batch Processing Strategies/typescript/batchPipeline.ts"

# a real 3-request batch (polls every 30s; usually minutes, up to 24h)
python "D4.5 - Efficient Batch Processing Strategies/python/batch_pipeline.py" --live
```

Expected offline output (abridged):

```
    30h       4h                 6  28h + 2h buffer = 30h
  submit once a day: worst observed latency 47.99h  <- misses the SLA

--- 1. Submit every document, custom_id = document id -------
  created msgbatch_fake_001: 24 requests, processing_status=in_progress
  ended after 0.54h: succeeded=21 errored=1 expired=2
  submitted order: ['doc-001', 'doc-002', 'doc-003', 'doc-004', 'doc-005', 'doc-006'] ...
  returned order : ['doc-022', 'doc-005', 'doc-013', 'doc-023', 'doc-006', 'doc-015'] ...
  zipping results to requests by position would mislabel 23 of 24
  FAILED doc-017: errored: invalid_request_error: prompt is too long: 7971 tokens > 6000 maximum
--- 2. Resubmit ONLY the failures, modified where needed ----
  doc-017: chunked into ['doc-017#p1', 'doc-017#p2', 'doc-017#p3']
  created msgbatch_fake_002: 5 requests, processing_status=in_progress
  merged ['doc-017#p1', 'doc-017#p2', 'doc-017#p3'] -> {'supplier': 'Northwind Office Supply', ..., 'notice_days': 45}
--- 3. Coverage and time against the SLA --------------------
  extracted 24/24 documents
  guaranteed bound with a resubmission round: 4h + 24h + 24h = 52h > SLA
```

The fake service uses a scaled-down 6,000-token context limit so the oversized document stays small. The real models have a 1M-token window, but the failure-handling logic is the same.

## Sync or batch?

| Workflow | API | Why |
|---|---|---|
| Pre-merge check | Synchronous | A developer is blocked; batches have no latency SLA |
| Agent that calls tools mid-task | Synchronous | A batch request is one shot: it ends on `tool_use`, and nothing runs the tool |
| Overnight tech-debt report | Batch | Nobody waits; 50% cheaper; usually done in under an hour |
| Weekly audit, nightly test generation | Batch | Same reasons |
| Any job with a hard deadline | Batch *if* `SLA >= 24h + buffer + window` | Otherwise synchronous, or start earlier |

## Exam traps

- **Sample question 11.** "Switch both workflows to batch for the savings" is wrong. Batch has no latency guarantee, so it cannot back a blocking pre-merge check, and polling does not fix that (B). A timeout fallback to real-time (D) adds complexity instead of matching each API to its use (A). "Keep real-time to avoid ordering issues" (C) is a misconception: `custom_id` correlates results in any order.
- **Never match results by position.** Here 23 of 24 would have been mislabelled.
- **Resubmit only what failed, and fix why it failed.** Resubmitting the whole batch pays twice for the documents that succeeded. Resubmitting the oversized document unchanged fails the same way again. Chunk it, give each chunk its own `custom_id` (`doc-017#p1`), and merge.
- **SLA arithmetic uses the 24h maximum, not the typical one hour.** Window = SLA - 24h - buffer. A daily submission looks efficient but gives a 48h worst case against a 30h SLA. A resubmission round is a second 24h in the worst case, so budget for it or send the few failures through the synchronous API.
- **No multi-turn tool use inside a batch.** If the task needs tool results mid-reasoning, every tool step becomes another full batch round trip. Use the synchronous API for agentic loops.
- **Refine on a sample first.** A prompt bug found after a 24h batch costs a day plus a resubmission. Found on 5 synchronous calls, it costs seconds.

## SDK notes

- Python: `client.messages.batches.create(requests=[...])`, where each request is `{"custom_id", "params"}` (`Request` / `MessageCreateParamsNonStreaming` typed dicts). Then `.retrieve(id).processing_status`, `.results(id)` (iterate, any order), and `.cancel(id)`. TypeScript: the same names on `lab.getRawClient().messages.batches`, with `for await (const r of await ...results(id))`.
- For an errored request, the error type is nested: `r.result.error.error.type` (for example `"invalid_request_error"`). `r.result.error.type` is the envelope (`"error"`).
- Batches run each request as an ordinary Messages call. Everything that works there (tools, structured outputs) works per request, but nothing executes between turns. Forced `tool_choice` is a 400 on `claude-opus-5-5` in batches too.

## Try this next

1. Change `expirations_per_batch` to `[2, 1]` so one resubmitted request expires again. Add a third round, and print the worst-case bound (4h + 3 x 24h) next to the SLA.
2. Raise the SLA to 48h in `batch_pipeline.py`. Use `max_submission_window()` to pick the new window, and confirm that a 22h window plus one resubmission round still fits.
3. Run `sample_refinement.py --live` with `PROMPT_V1` on the real model. Does it normalize dates without being told? Decide from the measured rate, not from the scripted 60%.
