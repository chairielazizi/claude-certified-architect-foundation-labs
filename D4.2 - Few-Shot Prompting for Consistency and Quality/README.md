# D4.2: Apply few-shot prompting to improve output consistency and quality

**Domain 4: Prompt Engineering & Structured Output (20%)** · Task Statement 4.2
**Exam scenarios:** Claude Code for Continuous Integration, Structured Data Extraction

## What the exam expects

| Knowledge | Skill |
|---|---|
| Few-shot examples are the most effective way to get consistently formatted, actionable output when detailed instructions alone give inconsistent results | Create 2-4 targeted examples for ambiguous scenarios that show the reasoning for choosing one action over plausible alternatives |
| Examples demonstrate how to handle ambiguous cases (tool selection for ambiguous requests, branch-level test coverage gaps) | Include examples that show the exact output format (location, issue, severity, suggested fix) |
| Examples let the model generalize judgment to novel patterns instead of matching only the cases you listed | Include examples that separate acceptable code patterns from genuine issues, to cut false positives while still generalizing |
| Examples reduce hallucination and empty fields in extraction (informal measurements, varied document structures) | Show correct extraction from varied structures (inline citations vs bibliographies, methodology sections vs embedded details) to fix null required fields |

## The pattern

```
system = instructions                      # what to do (necessary, not sufficient)
       + <examples>                        # 2-4, each targeting an ambiguity you have SEEN fail
           <example name="acceptable pattern that looks suspicious">
             <code>...</code>
             <reasoning>Not flagged: it logs and re-raises, nothing is swallowed.
                        (why this answer, not the plausible alternative)</reasoning>
             <output>[]</output>       # the exact output shape
           </example>
           <example name="genuine issue that resembles it"> ... </example>
         </examples>
```

Pick the examples from real failures. Use a zero-shot run to find the null fields or format drift first, then write one example per failure mode. Each example's `<reasoning>` should state the deciding principle. That principle is what carries over to inputs no example shows.

## Files

| File | What it shows |
|---|---|
| `fixtures/review_snippets.json` | 5 snippets: 3 genuine issues, 2 acceptable patterns that *look* risky. S4 and S5 are constructs no example shows |
| `fixtures/research_docs.json` | 4 documents: Methods heading + inline citations, embedded methods + bibliography, informal field notes ("a couple of cups"), and a structure no example shows (`Approach:` label, footnote `Notes`) |
| `python/fewshot_prompts.py`, `typescript/fewshotPrompts.ts` | Instructions, the review examples, the generic and targeted extraction examples, prompt builders |
| `python/scoring.py`, `typescript/scoring.ts` | pydantic / zod models, format-consistency scorer, missing-required-field scorer |
| `python/scripted_model.py`, `typescript/scriptedModel.ts` | Offline model whose behaviour depends on which examples the prompt contains |
| `python/review_format_fewshot.py`, `typescript/reviewFormatFewshot.ts` | Zero-shot vs few-shot review: format consistency, false positives, generalization |
| `python/extraction_fewshot.py`, `typescript/extractionFewshot.ts` | Zero-shot vs 1 generic example vs 2 targeted examples on varied documents |

## Run it

```bash
python "D4.2 - Few-Shot Prompting for Consistency and Quality/python/review_format_fewshot.py"
python "D4.2 - Few-Shot Prompting for Consistency and Quality/python/extraction_fewshot.py"
npx tsx "D4.2 - Few-Shot Prompting for Consistency and Quality/typescript/reviewFormatFewshot.ts"
npx tsx "D4.2 - Few-Shot Prompting for Consistency and Quality/typescript/extractionFewshot.ts"

# compare against the real model (costs tokens)
python "D4.2 - Few-Shot Prompting for Consistency and Quality/python/review_format_fewshot.py" --live
```

Expected offline output (abridged):

```
--- zero-shot: detailed instructions only -------------------
  S1 genuine           format BAD [severity: Input should be 'low', 'medium', 'high' or 'critical']
  S2 acceptable        format BAD [not JSON]
  S3 genuine           format BAD [JSON dict, not an array]
  -> format consistency 20%, false positives ['S2', 'S5'], caught ['S1', 'S3', 'S4']
--- few-shot: same instructions + 3 targeted examples -------
  -> format consistency 100%, false positives [], caught ['S1', 'S3', 'S4']

--- zero-shot: instructions only ----------------------------
  P2 [no Methods heading (method embedded in narrative),]
     methodology=NULL  citations=0/2  measurements=0/0  missing=['methodology', 'citations']
  -> required fields empty although present in the source: 8
--- few-shot: 1 generic example -----------------------------
  -> required fields empty although present in the source: 8
--- few-shot: 2 targeted examples with reasoning ------------
  -> required fields empty although present in the source: 0
  'a couple of cups of flour'      -> quantity=2.0 unit=cup approximate=True
```

The offline model is scripted to reproduce the failure modes the exam describes. Run `--live` to see how much drift the real model shows on your own instructions.

## Zero-shot vs few-shot at a glance

| | Zero-shot (instructions only) | 1 generic example | 2-4 targeted examples with reasoning |
|---|---|---|---|
| Output format | Drifts: prose, other key names, "Major" vs "high" | Fixed | Fixed |
| Acceptable-but-suspicious code | Flagged (false positive) | n/a | Left alone, with the principle stated |
| Novel constructs | Judged on surface features | Same as zero-shot | Judgment carries over (S4 flagged, S5 accepted, P4 extracted) |
| Bibliography / embedded methods / "a couple of cups" | Empty or null | Still empty | Extracted, informal values marked `approximate` |

## Exam traps

- **"Add more detailed instructions"** is the distractor when instructions are already detailed and output is still inconsistent. Few-shot examples are the most effective fix for format consistency.
- **More examples is not better.** The skill is 2-4 *targeted* examples for the ambiguous cases. A generic example fixes the shape but not the judgment (here the null count stayed at 8).
- **Examples need reasoning, not only answers.** Without the "why this and not that", the model copies surface patterns ("broad except = bad") instead of the principle ("is the failure still visible?").
- **Include an acceptable-pattern example.** Showing only bad code teaches the model to flag anything that resembles it. Showing a look-alike that is fine is what cuts false positives.
- **Null required fields are often a structure problem, not a model limit.** The information is there (in a bibliography, in a narrative sentence). An example with that structure fixes it. Do not make the field optional to hide the gap. That is a different tool: nullable fields are for information that is truly absent ([D4.3](<../D4.3 - Structured Output with Tool Use and JSON Schemas/README.md>)).
- **Informal values should be normalized, not dropped or invented.** Keep `original_text`, record the best numeric reading, and mark it `approximate`.
- Few-shot also applies outside review and extraction. The guide's other examples are tool selection for ambiguous requests and branch-level test coverage gaps. The rule is the same: show the ambiguous case and the reasoning.

## Try this next

1. Remove the acceptable-pattern example from `REVIEW_EXAMPLES` and rerun. Which snippets become false positives, and does the format stay consistent?
2. Add a document with a methodology table (`| Sample | n | Duration |`) and write a third targeted example for it. Check the zero-shot null count goes up first.
3. Run `extraction_fewshot.py --live`. Compare the real model's zero-shot handling of "a pinch of salt" with what the targeted examples ask for.
