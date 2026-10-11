# D4.6: Design multi-instance and multi-pass review architectures

**Domain 4: Prompt Engineering & Structured Output (20%)** · Task Statement 4.6
**Exam scenarios:** Claude Code for Continuous Integration, Code Generation with Claude Code

## What the exam expects

| Knowledge | Skill |
|---|---|
| Self-review is limited: a model keeps the reasoning context from generation, so it is less likely to question its own decisions in the same session | Use a second, independent Claude instance to review generated code without the generator's reasoning context |
| Independent review instances (with no prior reasoning context) catch subtle issues better than self-review instructions or extended thinking | Split large multi-file reviews into focused per-file passes for local issues, plus separate integration passes for cross-file data flow |
| Multi-pass review (per-file local passes plus cross-file integration passes) avoids attention dilution and contradictory findings | Run verification passes where the model self-reports confidence on each finding, so review routing can be calibrated |

## The pattern

```
generate:      [user: task] -> assistant: reasoning + code
self-review:   [user: task, assistant: reasoning + code, user: "review it"]   <- anchored on its own design
independent:   NEW instance, [user: <spec> + <code>]                          <- no generator reasoning

PR with N files:
  for file in files:  review(LOCAL_PROMPT, that one file)        # same prompt, same depth, every file
  review(INTEGRATION_PROMPT, all files)                          # only cross-file data flow
  for finding: route by finding.confidence
      >= 0.8 -> auto-post
      <  0.8 -> verify(VERIFY_PROMPT, finding + code) in a fresh instance
                confirmed -> post | rejected -> drop | uncertain -> human triage
```

## Files

| File | What it shows |
|---|---|
| `fixtures/pr/inventory/*.py` | A 7-file stock-tracking PR: one construct repeated in 3 files, a local bug in a late file, and two cross-file bugs (swapped `adjust_stock` arguments, `qty` vs `quantity` event key) |
| `python/generator_model.py`, `typescript/generatorModel.ts` | Task spec, prompts, and the offline generator/reviewer: anchored when its own reasoning is in context, spec-driven when it is not |
| `python/generator_review.py`, `typescript/generatorReview.ts` | Generator, then self-review twice ("review it", then "think very carefully") vs an independent instance. Checks what each request contains, and proves the bug is real |
| `python/review_engine.py`, `typescript/reviewEngine.ts` | Local / integration / single-pass / verify prompts, the finding schema (pydantic / zod) with `confidence`, detectors, and the offline reviewer |
| `python/multi_pass_review.py`, `typescript/multiPassReview.ts` | Sample question 12: single-pass vs per-file passes plus an integration pass, with a comparison table |
| `python/confidence_routing.py`, `typescript/confidenceRouting.ts` | Routing by self-reported confidence, plus a verification pass on the low-confidence findings |

## Run it

```bash
python "D4.6 - Multi-Instance and Multi-Pass Review Architectures/python/generator_review.py"
python "D4.6 - Multi-Instance and Multi-Pass Review Architectures/python/multi_pass_review.py"
python "D4.6 - Multi-Instance and Multi-Pass Review Architectures/python/confidence_routing.py"
npx tsx "D4.6 - Multi-Instance and Multi-Pass Review Architectures/typescript/multiPassReview.ts"

# the real model through the same architecture (1 + 7 + 1 review calls, plus verifications)
python "D4.6 - Multi-Instance and Multi-Pass Review Architectures/python/multi_pass_review.py" --live
```

Expected offline output (abridged):

```
--- 2. Self-review in the same conversation -----------------
  self-review (review): no issues found
  self-review (think very carefully): no issues found
--- 3. Independent reviewer: a new instance with only the spec and the code ---
  [high, conf 0.92] Off-by-one: the spec says pages are 1-based, but start = page * page_size skips the first page ...
  proof: paginate(range(10), page=1, page_size=3) -> [3, 4, 5] (spec says [0, 1, 2])

--- 1. Single pass: all 7 files in one request --------------
  repository.py:13  swallowed-exception         high   conf=0.90  Exception is logged and swallowed; ...
  events.py         approved swallowed-exception: Error handling logs the failure; looks fine.
  api.py            approved (file): Looks good.
--- Comparison ----------------------------------------------
                               single pass  multi-pass
  findings                               2          10
  contradictory verdicts                 2           0
  api.py negative quantity           False        True
  swapped adjust_stock args          False        True
  event key qty vs quantity          False        True

--- 2. Verification pass on the low-confidence findings -----
  models.py:7 unenforced-int-annotation (conf 0.40) -> rejected (0.15): Every quantity enters through int(body[...]) ...
  reports.py:3 unbounded-module-list (conf 0.60) -> confirmed (0.85): received_today is appended to ... never cleared
  api.py:5 int-parse-valueerror (conf 0.55) -> uncertain (0.50): ... the web framework's error mapping is not part of the diff.
  auto-posted : 8 ... human triage: 1 ... dropped: 1
```

The offline reviewer *simulates* anchoring and attention dilution with deterministic rules, so the failure modes are visible on every run. With the real model these effects are probabilistic. That is why the exam's answer is structural (independent instances, split passes) and not "try harder" or "use a bigger context window". Run `--live` to compare.

## Single pass vs multi-pass

| | Single pass (all files in one request) | Per-file passes + integration pass |
|---|---|---|
| Depth | Uneven: detailed on early files, superficial on later ones | The same prompt and depth for every file |
| Same construct in several files | Flagged in one, approved in another | Same verdict and severity everywhere |
| Local bug in a late file | Missed | Found |
| Cross-file data flow | Not looked at deliberately | A dedicated pass whose only job is call sites vs signatures and payload keys |
| Cost | 1 call | N + 1 calls (each smaller; can run in parallel) |

## Exam traps

- **"Ask the model to review its own work" / "use extended thinking"** is the distractor. In the same session the model still carries its generation reasoning ("page maps directly to an offset") and judges the code against it. A separate instance that gets only the spec and the code has no such anchor.
- **The independent reviewer must really be independent.** No generator messages, no "here is my reasoning" in the prompt. The lab checks that the review request is a single user message with spec + code.
- **Sample question 12.** Inconsistent depth, missed bugs and contradictory verdicts across 14 files call for focused per-file passes plus an integration pass (A). Making developers split PRs (B) moves the burden without fixing the system. A bigger context window (C) does not fix attention quality. Three full passes with 2-of-3 voting (D) suppresses real bugs that are only caught some of the time.
- **Per-file passes alone are not enough.** Both cross-file bugs here were invisible to every per-file pass: each needs two files at once. The integration pass is a separate pass with a separate prompt.
- **Confidence enables routing, not filtering by itself.** Self-reported confidence decides *where* a finding goes. A verification pass then re-checks the low-confidence ones independently: one was confirmed and posted, one was rejected, and only the truly undecidable one went to a human. Calibrate the threshold against labelled outcomes ([D5.5](<../D5.5 - Human Review Workflows and Confidence Calibration/README.md>)).
- Consistent per-file verdicts also come from explicit criteria and few-shot examples ([D4.1](<../D4.1 - Explicit Criteria to Reduce False Positives/README.md>), [D4.2](<../D4.2 - Few-Shot Prompting for Consistency and Quality/README.md>)). The multi-pass split makes sure each file actually gets that prompt's full attention.

## SDK notes

- An "independent instance" is just a new `messages.create` call whose `messages` starts fresh. The API is stateless, so independence comes from what you send, not from a new client object. In the Agent SDK the same idea is a subagent ([D1.3](<../D1.3 - Subagent Invocation Context Passing and Spawning/README.md>)): it starts with no parent history.
- Per-file passes are independent of each other, so in production run them concurrently (`asyncio.gather` / `Promise.all`), or as a Message Batch if the review is not blocking ([D4.5](<../D4.5 - Efficient Batch Processing Strategies/README.md>)).

## Try this next

1. Add an `inventory/transfer.py` that calls `repo.adjust_stock(item.sku, -qty)` correctly. Check that the integration pass does *not* flag it, and the single pass still skims it.
2. Move `api.py` to the front of `PR_ORDER` and rerun. The single pass now finds the api bug but misses something else. The per-file results do not change.
3. Lower `AUTO_POST_THRESHOLD` to 0.5 and see which finding now reaches developers without verification. Is it one that verification would have rejected?
