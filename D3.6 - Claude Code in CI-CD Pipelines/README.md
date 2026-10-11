# D3.6: Integrate Claude Code into CI/CD pipelines

**Domain 3: Claude Code Configuration & Workflows (20%)** · Task Statement 3.6
**Exam scenarios:** Claude Code for Continuous Integration, Code Generation with Claude Code

## What the exam expects

| Knowledge | Skill |
|---|---|
| The `-p` / `--print` flag runs Claude Code non-interactively in automated pipelines | Run Claude Code in CI with `-p` so the job never hangs waiting for input |
| `--output-format json` and `--json-schema` enforce structured output in CI | Use `--output-format json` with `--json-schema` to produce machine-parseable findings that get posted as inline PR comments |
| CLAUDE.md provides project context to CI-invoked Claude Code: testing standards, fixture conventions, review criteria | Include prior review findings when re-running after new commits, and report only new or still-unaddressed issues |
| Session context isolation: the session that generated code is worse at reviewing it than an independent review instance | Put existing test files in context so test generation doesn't repeat covered scenarios. Document testing standards, valuable-test criteria and fixtures in CLAUDE.md |

## The pattern

```
pull_request (opened | synchronize)
  1. collect findings this job posted earlier      gh api .../pulls/N/comments  (hidden id markers)
  2. claude -p "<review prompt + prior findings>"  non-interactive, loads ./CLAUDE.md (review criteria)
        --output-format json --json-schema "$(cat ci/review-findings.schema.json)"
        --allowedTools "Read,Grep,Glob,Bash(git diff *),Bash(git log *)" --max-turns 12
  3. .structured_output -> reconcile with prior     new -> comment | still_open / repeat -> skip | resolved -> summary
  4. POST /repos/{o}/{r}/pulls/N/reviews           {commit_id, event: COMMENT, body, comments:[{path,line,side,body}]}

reviewer = a separate `claude -p` invocation      never --resume/--continue/--fork-session of the generator
```

## Files

| File | What it shows |
|---|---|
| `example-repo/.github/workflows/claude-pr-review.yml` | The CLI run directly: `claude -p ... --output-format json --json-schema "$(cat ...)" --allowedTools ... --max-turns`, least-privilege `permissions`, the `ANTHROPIC_API_KEY` secret, prior-comment collection, and `jq` turning `.structured_output` into one review with inline comments, posting only `status == "new"` |
| `example-repo/.github/workflows/claude-code-action.yml` | The alternative: `anthropics/claude-code-action@v1` with `anthropic_api_key`, `prompt` and `claude_args` (including the action's inline-comment MCP tool) |
| `example-repo/ci/review-findings.schema.json` | The findings contract: stable `id`, `status` (`new` / `still_open`), file, line, severity, category, plus `resolved_prior_ids` |
| `example-repo/ci/test-scenarios.schema.json` | The contract for test-generation output |
| `example-repo/CLAUDE.md` | Project context for developers **and** CI: review criteria with severities, testing standards, what counts as a valuable test, and the available fixtures |
| `example-repo/src/payments/refunds.py`, `tests/` | The pull request under review (4 seeded issues), the existing tests, and the fixtures in `conftest.py` |
| `fixtures/*.json` | Recorded `claude -p --output-format json` result envelopes: review push 1, review push 2, the generator session, a same-session self-review |
| `python/ci_review.py`, `typescript/ciReview.ts` | Builds the argv, runs the CLI (live) or loads a fixture (offline), validates `structured_output` against the schema, recovers prior findings from PR comment markers, reconciles (new / still open / duplicate / resolved), builds the GitHub review payload (dry run), and lints both workflows |
| `python/test_gen.py`, `typescript/testGen.ts` | Test generation with and without CLAUDE.md and existing tests in context, plus `dedupe()` of proposed vs existing scenarios |
| `python/independent_review.py`, `typescript/independentReview.ts` | `is_independent(argv)`: a `--resume`d or `--fork-session` self-review vs a fresh `claude -p` reviewer, compared on recorded results |

## Run it

```bash
python "D3.6 - Claude Code in CI-CD Pipelines/python/ci_review.py"
python "D3.6 - Claude Code in CI-CD Pipelines/python/test_gen.py"
python "D3.6 - Claude Code in CI-CD Pipelines/python/independent_review.py"
npx tsx "D3.6 - Claude Code in CI-CD Pipelines/typescript/ciReview.ts"
npx tsx "D3.6 - Claude Code in CI-CD Pipelines/typescript/testGen.ts"
npx tsx "D3.6 - Claude Code in CI-CD Pipelines/typescript/independentReview.ts"

# live: ci_review runs the real `claude` CLI inside example-repo/ (needs it installed + credentials);
# test_gen calls the Messages API. Nothing ever calls GitHub: payloads are printed, not posted.
python "D3.6 - Claude Code in CI-CD Pipelines/python/ci_review.py" --live
```

Expected offline output (abridged):

```
  [PASS] every claude invocation uses -p (sample Q10: otherwise the job hangs on input)
--- Push 1: first review of the pull request ---
  $ claude -p 'Review the changes in this pull request ...' --output-format json --json-schema "$(cat ci/review-findings.schema.json)" --allowedTools 'Read,Grep,Glob,Bash(git diff *),Bash(git log *)' --max-turns 12
    critical security      src/payments/refunds.py:27   Charge lookup builds SQL with an f-string
    ...
--- Push 2: the developer fixed some issues; review again ---
  resolved by the new commits : ['sql-injection-charge-lookup', 'card-number-logged']
  duplicates suppressed       : [('float-refund-amount', 'float-money-conversion')]
  new -> inline comments      : ['idempotency-key-not-forwarded']
--- B. CLAUDE.md as system context + existing tests in the prompt ---
  dedupe dropped: [('test_unsettled_charge_refund_rejected', 'test_refund_requires_settled_charge', 0.62)]
  [PASS] the independent reviewer found the 3 critical issues the self-review rationalized away
```

## Why CLAUDE.md lives at the repo root (not ci/CLAUDE.md)

`claude -p` started from the repo root loads `./CLAUDE.md` (and its ancestors) at launch. A
`ci/CLAUDE.md` would load only on demand, once Claude happened to read a file inside `ci/`, so the review
criteria might never reach the reviewer. Keep the shared context (review criteria, testing standards,
fixtures) in the root CLAUDE.md that developers and CI both use. Instructions that only make sense in CI
(for example "post nothing yourself, return JSON") belong in the prompt, or in `--append-system-prompt`.
See [D3.1](<../D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/README.md>) for the loading rules.

## Exam traps

- **Sample question 10.** `claude "Analyze this pull request..."` hangs because Claude Code is waiting for interactive input. The answer is (A): add `-p` (`--print`), which processes the prompt, prints to stdout and exits. `CLAUDE_HEADLESS=true` (B) and `--batch` (D) don't exist. Redirecting stdin from `/dev/null` (C) is a Unix workaround, not the documented non-interactive mode.
- **Structured findings need both flags.** `--output-format json` gives the result envelope (`result`, `session_id`, `total_cost_usd`, `is_error`). `--json-schema` makes Claude Code validate the output, which lands in `structured_output`. Parsing free text with regexes is the fragile alternative.
- **Re-runs must not repeat comments.** Feed the previously posted findings back into the prompt, and tell Claude to report only new or still-unaddressed issues and to name the resolved ones. Back that up with a deterministic reconcile, since lines shift and titles get re-worded.
- **Self-review is weak review.** The generating session already "knows" why its choices were fine. Run the reviewer as a separate `claude -p` invocation. `--resume`, `--continue` and `--fork-session` all bring the generator's context along.
- **Context makes test generation useful.** Without the existing tests in context, generation repeats covered scenarios. Without CLAUDE.md's fixtures and value criteria, it invents mocks and filler tests (`test_refund_dataclass_fields`).
- **Least privilege.** Scope `--allowedTools` to what the review needs (read, grep, `git diff`), set `--max-turns`, use the `pull-requests: write` permission instead of `write-all`, and read the API key from `secrets`.

## SDK notes

- `--allowedTools` takes a comma-separated string (`"Read,Grep,Bash(git diff *)"`). The docs also show space-separated quoted entries.
- In `claude-code-action@v1`, the inline-comment tool `mcp__github_inline_comment__create_inline_comment` is available only when `--allowedTools` in `claude_args` names it. The official examples also grant `id-token: write`.
- The lab's dedupe heuristic (file + category + title Jaccard >= 0.5) is a safety net, not a guarantee. Stable ids that Claude is told to reuse do most of the work.

## Try this next

1. Add a third push fixture where the developer fixes the cumulative-limit bug, and check that it moves to `resolved` while the idempotency finding stays open.
2. Make the workflow fail the job (`exit 1`) when any `critical` finding is new or still open. That turns the review into a merge gate.
3. Have `test_gen` write the four final scenarios into `tests/test_refunds_generated.py` via a second `claude -p` call, then run pytest on them in CI.
