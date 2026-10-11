# D4.1: Design prompts with explicit criteria to improve precision and reduce false positives

**Domain 4: Prompt Engineering & Structured Output (20%)** · Task Statement 4.1
**Exam scenarios:** Claude Code for Continuous Integration

## What the exam expects

| Knowledge | Skill |
|---|---|
| Explicit criteria beat vague instructions: "flag comments only when claimed behavior contradicts actual code behavior" vs "check that comments are accurate" | Write review criteria that say which issues to **report** (bugs, security) and which to **skip** (minor style, local patterns), instead of relying on confidence-based filtering |
| "Be conservative" and "only report high-confidence findings" do not improve precision the way specific categorical criteria do | Temporarily disable high false-positive categories to restore developer trust while you improve the prompts for those categories |
| High false-positive categories undermine trust in the accurate categories too | Define explicit severity criteria with a concrete code example for each level, so classification is consistent |

## The pattern

```
REPORT only these categories:            <- what qualifies, per category
- bug: wrong result / crash on a realistic input (name the input)
- security: injection, auth bypass, secret exposure ...
- comment_accuracy: ONLY when the comment contradicts what the code does
SKIP (even when you are confident):      <- what does NOT qualify
- style: naming, formatting, missing hints/docstrings
- local_pattern: matches a pattern used consistently in this codebase
- <toggled-off category>: temporarily disabled while its criteria are improved
SEVERITY RUBRIC (one code example per level)
- critical: f"... WHERE id = '{user_id}'"   high: rows // PAGE_SIZE   medium: "# returns None" + raises ...

measure: precision per category from labelled findings
         -> category below the bar (with enough samples)? toggle it off, rewrite its criterion,
            re-measure on a labelled sample, toggle it back on
```

## Files

| File | What it shows |
|---|---|
| `fixtures/sample_diff.txt` | A small diff with 3 real issues (SQL injection, off-by-one paging, a comment that contradicts the code) and 5 things a reviewer could nitpick |
| `fixtures/diff_observations.json` | Everything a reviewer could notice in that diff, with the audit label, the rubric severity and the reviewer's self-confidence |
| `fixtures/historical_findings.json` | Four weeks of labelled production findings plus what developers did with them |
| `python/review_criteria.py`, `typescript/reviewCriteria.ts` | Category definitions, toggles, severity rubric, the three prompt builders, the findings schema (pydantic / zod) and precision metrics |
| `python/scripted_reviewer.py`, `typescript/scriptedReviewer.ts` | Offline reviewer whose output depends on how explicit the system prompt is |
| `python/precision_report.py`, `typescript/precisionReport.ts` | Precision per category, the trust erosion it causes, and the toggle that fixes overall precision |
| `python/vague_vs_explicit.py`, `typescript/vagueVsExplicit.ts` | The same diff reviewed with vague, "be conservative" and explicit prompts, scored against the audit labels |

## Run it

```bash
python "D4.1 - Explicit Criteria to Reduce False Positives/python/precision_report.py"
python "D4.1 - Explicit Criteria to Reduce False Positives/python/vague_vs_explicit.py"
npx tsx "D4.1 - Explicit Criteria to Reduce False Positives/typescript/precisionReport.ts"
npx tsx "D4.1 - Explicit Criteria to Reduce False Positives/typescript/vagueVsExplicit.ts"

# the real model on the same diff and prompts (costs tokens)
python "D4.1 - Explicit Criteria to Reduce False Positives/python/vague_vs_explicit.py" --live
```

Expected offline output (abridged):

```
--- 1. Precision per category (4 weeks, audited labels) -----
  comment_accuracy         12         3        25%
  bug                      10         9        90%
  OVERALL                  34        21        62%
--- 2. The trust cost: real issues get ignored too ----------
  real bug/security/performance findings dismissed, weeks 1-2: 0%
  real bug/security/performance findings dismissed, weeks 3-4: 67%
--- 3. Toggle the high-false-positive category off ----------
  overall precision: 62% -> 82% with ['comment_accuracy'] disabled
...
--- Comparison ----------------------------------------------
  prompt                           findings  precision  recall
  vague                                   8        38%    100%
  conservative                            7        43%    100%
  explicit                                3       100%    100%
  explicit, comment_accuracy off          2       100%     67%
```

## Why "be conservative" does not work

| Prompt | What the reviewer reports on the sample diff |
|---|---|
| "Check that comments are accurate" | The real contradiction, plus "comment says 'all orders' but selects two columns" and "comment doesn't mention escaping". Wording nitpicks are technically about accuracy. |
| "+ Be conservative, only report high-confidence findings" | Drops one low-confidence comment nit. Keeps "single-letter parameter `o`" and "no type hints" because the model is *very* confident about those. Confidence measures certainty, not relevance. |
| Explicit REPORT / SKIP + "only when it contradicts the code" | The 3 real issues only. Style and the codebase's own `PAGE_SIZE = 50` convention are listed under SKIP. |
| No rubric vs rubric with code examples | Without a rubric the SQL injection was "medium" and a missing docstring "high". With one example per level the severities match the audit. |

## Exam traps

- **"Tell it to be conservative" / "only report high-confidence findings"** sounds like a precision fix, but it does not define *what* to skip. A model can be highly confident that a variable name is short. The fix is categorical criteria.
- **One noisy category damages trust in all of them.** In the fixture, real bug and security findings went from 0% to 67% dismissed once developers had seen enough wording nitpicks. Measure precision **per category**. Overall precision hides which category causes the damage.
- **Disabling a category is a temporary, measured move.** Turn it off (with enough samples to be sure it is noisy), rewrite its criterion, re-validate it on labelled examples, then turn it back on. Throwing away the whole review, or keeping it and asking developers to "ignore the noise", are both wrong answers.
- **"Check that X is accurate" is vague. "Flag X only when Y contradicts Z" is explicit.** The exam uses the comment example. The same rewrite works for docs, tests and naming.
- **Severity needs examples, not adjectives.** "High = serious" gives inconsistent labels. One concrete code example per level gives consistent ones. Few-shot examples ([D4.2](<../D4.2 - Few-Shot Prompting for Consistency and Quality/README.md>)) take this further.
- Tracking *which construct* triggered each dismissed finding (`detected_pattern`) shows you which criterion to rewrite. See [D4.4](<../D4.4 - Validation Retry and Feedback Loops/README.md>).

## SDK notes

- Live mode sends `output_config={"format": {"type": "json_schema", "schema": ...}}` so every response is parseable JSON. That keeps this lab about *which* findings come back. Schema enforcement is covered in [D4.3](<../D4.3 - Structured Output with Tool Use and JSON Schemas/README.md>).

## Try this next

1. Rewrite the `comment_accuracy` criterion (for example, add two contradiction examples), re-enable it, and add labelled week-5 findings to the fixture to check it now clears the 60% bar.
2. Add a `performance` observation to the diff that is real only at scale (a loop over a 20-row config list). Write a criterion that skips it, then check that the explicit prompt drops it.
3. Run `vague_vs_explicit.py --live` and compare the real model's vague-prompt output with the scripted one. Which nitpicks does it actually produce?
