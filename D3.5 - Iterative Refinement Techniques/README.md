# D3.5: Apply iterative refinement techniques for progressive improvement

**Domain 3: Claude Code Configuration & Workflows (20%)** · Task Statement 3.5
**Exam scenarios:** Code Generation with Claude Code, Developer Productivity with Claude

## What the exam expects

| Knowledge | Skill |
|---|---|
| Concrete input/output examples are the most effective way to communicate a transformation when prose descriptions get interpreted inconsistently | Provide 2-3 concrete input/output examples when natural-language descriptions produce inconsistent results |
| Test-driven iteration: write the test suite first, then iterate by sharing test failures | Write tests covering expected behavior, edge cases and performance requirements before implementation, then iterate by sharing failures |
| The interview pattern: Claude asks questions to surface considerations the developer may not have anticipated | Use the interview pattern to surface design considerations (cache invalidation, failure modes) before implementing in an unfamiliar domain |
| When to put all issues in one message (interacting problems) and when to fix them one at a time (independent problems) | Provide specific test cases with example input and expected output to fix edge cases (null values in migration scripts). Address interacting issues in one detailed message and independent ones sequentially |

## The pattern

```
1. examples > prose     "uppercase, hyphen, number, variant"      -> 2/6 in the intended format
                        + "ab 12" -> "AB-0012", "kt_9_red" -> "KT-0009-RED", ...   -> 6/6
2. tests first          write tests (behavior + nulls + perf) -> Claude implements
                        loop: run tests in a subprocess -> send (input, expected, actual) -> revise
                        until green (bounded)              8 failures -> 1 -> 0
3. interview            "ask me up to 5 questions before writing code" -> answers -> design
4. batch by interaction issues sharing a function/field -> ONE message with all expectations
                        independent issues -> one message each, in sequence
```

## Files

| File | What it shows |
|---|---|
| `python/examples_vs_prose.py`, `typescript/examplesVsProse.ts` | The same product-code normalization prompted with prose only, then with 3 examples. Uses structured JSON output (`output_config.format`). The scripted model gives each item one of the readings the prose allows, and follows the rule the examples pin down |
| `python/migration_tests.py`, `typescript/migrationTests.ts` | The **test suite written first**: expected behavior, null/missing-value edge cases, and a performance requirement (one country-table load per 20k-record batch) |
| `python/migration_harness.py`, `typescript/migrationHarness.ts` | Runs the suite against a candidate file **in a subprocess** and prints JSON results (input, expected, actual, error) |
| `python/test_driven_iteration.py`, `typescript/testDrivenIteration.ts` | The bounded loop: Claude writes the module, the harness runs it (subprocess plus timeout), failures go back verbatim, repeat until green. Candidates are written to `.lab-runtime/tdd/round<N>/` |
| `python/scripted_fixes.py`, `typescript/scriptedFixes.ts` | The offline model. Round 1 is naive. Round 2 fixes every listed failure but parses money through floats (120434 instead of 120435). Round 3 fixes that once the exact actual/expected pair is shown |
| `python/interview_pattern.py`, `typescript/interviewPattern.ts` | A caching task with and without "interview me first". The interview surfaces invalidation, failure modes and consistency, and the design applies each answer |
| `python/issue_batching.py`, `typescript/issueBatching.ts` | `group_interacting()` uses union-find over shared functions, fields and files. `plan_messages()` produces one combined message for interacting issues and single messages for independent ones |

## Run it

```bash
python "D3.5 - Iterative Refinement Techniques/python/examples_vs_prose.py"
python "D3.5 - Iterative Refinement Techniques/python/test_driven_iteration.py"
python "D3.5 - Iterative Refinement Techniques/python/interview_pattern.py"
python "D3.5 - Iterative Refinement Techniques/python/issue_batching.py"
npx tsx "D3.5 - Iterative Refinement Techniques/typescript/testDrivenIteration.ts"   # likewise for the others

# real Claude (costs tokens); model-written code still only runs in the subprocess harness
python "D3.5 - Iterative Refinement Techniques/python/test_driven_iteration.py" --live
```

Expected offline output (abridged):

```
--- A. Prose description only ---
  "  pd 101  "   -> PD-101           shape AA-999
  "LM/88/xl"     -> LM88-XL          shape AA99-AA
--- B. Same prose + 3 concrete examples ---
  "  pd 101  "   -> PD-0101          shape AA-9999
  "LM/88/xl"     -> LM-0088-XL       shape AA-9999-AA
  in the intended format (AA-9999[-VARIANT]): prose 2/6, examples 6/6

--- Round 1: 3/11 passing ---
  FAIL keeps a null phone as null: TypeError: 'NoneType' object is not iterable
  FAIL migrate_all loads the country table once for 20,000 records: "20000 table load(s), ..."
--- Round 2: 10/11 passing ---
  FAIL parses a balance with a thousands separator exactly: {... "balance_cents": 120434 ...}
--- Round 3: 11/11 passing ---
  [PASS] each round's shared failures drove the next revision: 8 -> 1 -> 0
```

## Choosing the technique

| Symptom | Technique | Why it works |
|---|---|---|
| Output format varies between items or runs | 2-3 input/output examples | Examples settle the details prose leaves open (padding, separators, casing) |
| "It works on the happy path" | Tests first, then share failures | The tests define done. Failures arrive as precise, actionable feedback (input, expected, actual) |
| You don't know what you don't know | Interview pattern | Claude asks about invalidation, failure modes and consistency before committing to a design |
| Several bugs at once | Group by interaction | Interacting fixes go in one message, so they're designed together. Independent ones go one at a time, so each is small and verifiable |

## Exam traps

- **More prose is not the fix for inconsistent output.** When a description is applied inconsistently, the exam's answer is concrete input/output examples (2-3 of them), not a longer description or capitals.
- **Tests come first, and failures go back verbatim.** "Make it handle edge cases better" is vague. "Input `{"phone": null}`, expected `"phone": null`, actual `TypeError`" is actionable. Round 3 in the demo works only because the exact `120434` vs `120435` pair reaches the model.
- **Include the performance requirement in the suite.** "Loads the lookup table once per batch" is testable, so it gets tested, and the first attempt fails it.
- **Run model-written code out of process.** The harness runs in a subprocess with a timeout. Never `exec` generated code inside your own process.
- **Interacting vs independent.** Problems that touch the same function or data belong in one detailed message, because sequential fixes would undo each other. Independent problems go one at a time. Sending everything in one message every time, or always going one by one, are both wrong.
- **The interview pattern is for unfamiliar domains.** It is the first step before implementation, not a replacement for the tests.

## SDK notes

- Structured output uses `output_config={"format": {"type": "json_schema", "schema": ...}}` on `messages.create`. The first text block is then valid JSON. The TypeScript version casts the params via `unknown`, in case your installed SDK's type definitions predate the field.
- The TypeScript loop runs candidates with `node node_modules/tsx/dist/cli.mjs migrationHarness.ts <candidate.ts>`, so `npm install` is required.

## Try this next

1. Remove the `"kt_9_red"` example, leaving 2 examples with no variant. Run `examples_vs_prose.py --live` and see whether variant formatting drifts again.
2. Add a test "rejects a negative balance" to `migration_tests.py` without changing `scripted_fixes.py`. The loop now stops at the round bound, which is why the bound exists.
3. Add an issue I6, "price_cents serialized as a float in the API response", that touches `field:price_cents`, and confirm it joins the combined message.
