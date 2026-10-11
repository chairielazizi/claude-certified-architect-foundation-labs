# D1.6: Design task decomposition strategies for complex workflows

**Domain 1: Agentic Architecture & Orchestration (27%)** · Task Statement 1.6
**Exam scenarios:** Claude Code for Continuous Integration (multi-file PR review), Developer Productivity with Claude (legacy codebases), Multi-Agent Research System

## What the exam expects

| Knowledge | Skill |
|---|---|
| When to use a fixed sequential pipeline (prompt chaining) and when to use dynamic, adaptive decomposition driven by intermediate findings | Pick the pattern for the workflow: prompt chaining for predictable multi-aspect reviews, dynamic decomposition for open-ended investigation |
| Prompt chaining for reviews: analyze each file on its own, then run a cross-file integration pass | Split large reviews into per-file local passes plus a separate integration pass to avoid attention dilution |
| Adaptive investigation plans that create subtasks from what each step discovers | Decompose open-ended work ("add comprehensive tests to a legacy codebase") by mapping structure, finding high-impact areas, then following a prioritized plan that adapts as dependencies are discovered |

## The pattern

```
PROMPT CHAINING (steps fixed before you start)        DYNAMIC DECOMPOSITION (findings create the steps)

for file in pr.files:                                 map = map_structure(repo)            # code / tools
    report[file] = review_one(file)  # 1 file/call    plan = planner(map)                  # prioritized
integration = review_links(report)   # interfaces,    while plan.pending:
                                     # not sources        result = worker(next_runnable(plan))
comments = merge(report, integration) # plain code        if result.blocked:               # discovery
                                                          plan = planner(map, plan, result) # insert +
                                                                                            # re-prioritize
```

## Files

| File | What it shows |
|---|---|
| `fixtures/pr_1482/` | A 4-file PR. `billing.py` changed `calculate_total(items, tax_rate)` to `(items, region)`, but `api.py` still passes `tax_rate=`. Each file also has (or lacks) one local bug |
| `fixtures/legacy_shop/` | A mini legacy repo: 8 modules, an import graph, `# criticality:` tags, and tests for `utils.py` only |
| `python/choose_strategy.py`, `typescript/chooseStrategy.ts` | `choose_strategy(task)`: the decision rule, applied to six example tasks |
| `python/pr_review_chain.py`, `typescript/prReviewChain.ts` | (a) Prompt chaining: per-file passes, then an integration pass over the reports, then a merge. Also a single-pass contrast (sample Q12) |
| `python/adaptive_test_plan.py`, `typescript/adaptiveTestPlan.ts` | (b) Map, score impact, plan, run. Blocked workers report missing fixtures and the planner re-plans |
| `python/code_analysis.py`, `typescript/codeAnalysis.ts` | Regex reading of the fixtures: imports, signatures, calls, fan-in, impact score |
| `python/scripted_models.py`, `typescript/scriptedModels.ts` | Model-driven offline roles (per-file reviewer, integration reviewer, single-pass reviewer, planner, worker), chosen by system prompt |

## Run it

```bash
# from the repo root
python "D1.6 - Task Decomposition Strategies for Complex Workflows/python/choose_strategy.py"
python "D1.6 - Task Decomposition Strategies for Complex Workflows/python/pr_review_chain.py"
python "D1.6 - Task Decomposition Strategies for Complex Workflows/python/adaptive_test_plan.py"
npx tsx "D1.6 - Task Decomposition Strategies for Complex Workflows/typescript/chooseStrategy.ts"
npx tsx "D1.6 - Task Decomposition Strategies for Complex Workflows/typescript/prReviewChain.ts"
npx tsx "D1.6 - Task Decomposition Strategies for Complex Workflows/typescript/adaptiveTestPlan.ts"

# real Claude API (costs tokens; every step uses structured JSON outputs)
python "D1.6 - Task Decomposition Strategies for Complex Workflows/python/pr_review_chain.py" --live
```

Expected offline output (abridged):

```
--- Step 1: per-file local analysis (one call per file) ---
api.py: HTTP handlers for checkout. Calls billing.apply_discount, billing.calculate_total (signature not visible in this file).
    line 13: bare `except:` swallows every error (TypeError included) and hides the cause
cart.py: Shopping cart persistence.
    line 17: off-by-one: index == len(...) passes the check, then raises IndexError
--- Step 2: cross-file integration pass ---
  api.py -> billing.calculate_total
    api.py calls calculate_total(cart.items, tax_rate=TAX_RATE) but billing.py now defines calculate_total(items, region):
    unknown keyword 'tax_rate'; missing required 'region'. This raises TypeError at runtime, which api.py's bare except
    turns into a silent 500.
--- Contrast: one pass over all files at once ---
  cart.py: Looks fine.
  [PASS] the single pass skimmed later files and missed cart.py's off-by-one (attention dilution)

--- 3-4. Plan, execute, discover, re-plan ---
  [plan v1] T1 write tests db.py
              T2 write tests pricing.py ...
  run T3 payments.py: BLOCKED, needs fake_db, gateway_stub
  planner: F2 fake_db now blocks payments.py, orders.py, models.py, reports.py; F3 gateway_stub now blocks payments.py
  [plan v3] F2 build fixture fake_db
              F3 build fixture gateway_stub
              T3 write tests payments.py [after F2,F3] ...
  [PASS] the plan adapted: 5 fixture tasks were discovered and inserted
  [PASS] one discovery re-planned other tasks: models.py and reports.py waited for fake_db and were never blocked
```

## Choosing the strategy

| Question about the task | Prompt chaining | Dynamic decomposition |
|---|---|---|
| Are the steps known before you start? | Yes: per file, then integration | No: the next step depends on the last result |
| Can the inputs be listed up front? | Yes: the PR's files, the 30 merged PRs | Not really: "the codebase", "wherever PII leaks" |
| Can a finding create new work? | No. Findings are output, not plan changes | Yes. A missing DB fake becomes a new task that blocks four others |
| What it buys you | Consistent depth, parallelizable steps, easy to test | Coverage of work nobody could foresee, effort spent where impact is highest |
| Failure if misapplied | Misses discovered work, or runs pointless steps | Costs more and can wander on a task a fixed checklist would cover |

Why the integration pass gets **reports, not sources.** Its job is the links between files: signatures, calls, data flow. A compact interface view keeps that one call focused. Sending every full file again would bring back the dilution the per-file split removed.

## Exam traps

- **Sample Q12 (14-file PR, inconsistent single-pass review).** The answer is per-file local passes plus a separate integration pass. A bigger context window (C) does not fix attention quality. Requiring developers to split PRs (B) just moves the burden onto people. Consensus across three runs (D) suppresses real bugs that are only caught some of the time.
- **Per-file passes alone are not enough.** In this demo no single file is wrong: `api.py` calling `calculate_total(..., tax_rate=)` only breaks against `billing.py`'s new signature. The chain needs the integration step.
- **Do not build a fixed pipeline for open-ended work.** "Add comprehensive tests to a legacy codebase" cannot be scripted up front. Map the structure, prioritize by impact (fan-in, criticality, missing tests), and re-plan when the work turns up dependencies.
- **Adaptive does not mean ad hoc.** The plan stays explicit: ids, priorities and `depends_on`. Code enforces the dependency order, and a deadlocked plan raises instead of looping.
- **A narrow decomposition is a root cause in its own right.** Sample Q7: the coordinator split "creative industries" into three visual-arts subtasks, and every downstream agent then did its narrow job correctly. Check coverage when you decompose.

## Try this next

1. Add a fifth file to the PR, `invoices.py`, that calls `calculate_total(items, "US-CA", 0.08)`. Confirm that the integration pass reports "3 positional args for 2 params" and that no per-file pass does.
2. Run the per-file passes concurrently with `lab.get_async_client(scripted_model, latency_s=0.3)` and `asyncio.gather`. The chain's steps are independent, so the wall-clock time should drop to about one call.
3. Add `import requests` to `reports.py` and rerun the adaptive plan. Predict which plan version picks up the new dependency, and why `reports.py` is never blocked.
