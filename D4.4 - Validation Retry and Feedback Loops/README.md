# D4.4: Implement validation, retry, and feedback loops for extraction quality

**Domain 4: Prompt Engineering & Structured Output (20%)** · Task Statement 4.4
**Exam scenarios:** Structured Data Extraction, Claude Code for Continuous Integration

## What the exam expects

| Knowledge | Skill |
|---|---|
| Retry with error feedback: append the specific validation errors to the prompt on retry so the model can correct itself | Send follow-up requests that include the original document, the failed extraction and the specific validation errors |
| Retries do not help when the required information is absent from the source (as opposed to format or structural errors) | Tell when a retry will fail (the information is in an external document that was not provided) and when it will work (format mismatch, structural error) |
| Feedback loop design: track which code construct triggered each finding (`detected_pattern`) so dismissals can be analysed | Add `detected_pattern` to structured findings so you can find false-positive patterns when developers dismiss findings |
| Semantic validation errors (values don't sum, wrong field) differ from schema syntax errors (which tool use removes) | Design self-correcting flows: extract `calculated_total` next to `stated_total`, add `conflict_detected` for inconsistent source data |

## The pattern

```
messages = [user: <document>]
loop (max 2 retries):
    response = create(tools=[extract_invoice], messages)
    issues = validate(tool_use.input)            # pydantic / zod: formats, sums, conflict flag
    if no issues:          accept  (conflict_detected? -> human review, NOT a retry)
    retryable = [i for i in issues if i is format/structural/arithmetic
                                   or the value is visibly in the document]
    if no retryable:       keep null + *_missing_reason, route on   (retrying would waste calls)
    messages += [assistant: failed tool_use,                       # the failed extraction
                 user: tool_result(is_error=True, "- invoice_date: must be ISO 8601, got '14/03/2026'")]
                                                                   # messages[0] = the original document

review findings: {file, category, detected_pattern, message} + developer accept/dismiss
    -> dismissal rate per detected_pattern -> rewrite the criterion for the noisy construct
```

## Files

| File | What it shows |
|---|---|
| `fixtures/invoices.json` | INV-A has format errors on the first pass. INV-B's PO number is in an attachment that was not provided. INV-C's source totals disagree. INV-D is clean |
| `fixtures/review_history.json` | 36 review findings with `detected_pattern` and simulated developer accept/dismiss |
| `python/invoice_validation.py`, `typescript/invoiceValidation.ts` | The extraction tool, the pydantic / zod model (ISO date, ISO 4217, `calculated_total` vs line items, `conflict_detected` consistency), issue classification, `is_retryable`, feedback text |
| `python/scripted_extractor.py`, `typescript/scriptedExtractor.ts` | Offline model: copies values as printed on the first pass, fixes exactly the fields named in the feedback, cannot invent a missing PO |
| `python/retry_loop.py`, `typescript/retryLoop.ts` | The smart retry loop, the contents of the retry request, and a naive "retry everything" loop for comparison |
| `python/dismissal_analysis.py`, `typescript/dismissalAnalysis.ts` | Dismissal rate overall, by category, and by `detected_pattern` |

## Run it

```bash
python "D4.4 - Validation Retry and Feedback Loops/python/retry_loop.py"
python "D4.4 - Validation Retry and Feedback Loops/python/dismissal_analysis.py"
npx tsx "D4.4 - Validation Retry and Feedback Loops/typescript/retryLoop.ts"
npx tsx "D4.4 - Validation Retry and Feedback Loops/typescript/dismissalAnalysis.ts"

# the real model through the same loop (costs tokens)
python "D4.4 - Validation Retry and Feedback Loops/python/retry_loop.py" --live
```

Expected offline output (abridged):

```
  INV-A (format errors on the first pass ...)
     attempt 1: invoice_date [format]: must be ISO 8601 YYYY-MM-DD, got '14/03/2026'; currency [format]: ...
     attempt 2: valid
     -> accepted after 2 call(s)
  INV-B (PO number lives in a document that was not provided; retrying cannot help)
     attempt 1: po_number [missing_required, NOT retryable]: required for payment: ...
     -> accepted_with_gaps after 1 call(s)  null + reason: {'po_number': "The document says 'see the attached purchase order', ..."}
  INV-C (the source itself is inconsistent: items sum to 1,150, stated total 1,200)
     -> needs_review after 1 call(s)  stated_total=1200.0 calculated_total=1150.0
--- 3. Naive loop (retry every error) vs smart loop ---------
  INV-B: naive 3 call(s) -> failed             smart 1 call(s) -> accepted_with_gaps
  wasted retries avoided: 2

--- 3. By detected_pattern ----------------------------------
  magic-number-in-test       6          6   100%  <- false-positive source
  broad-except-reraise       9          8    89%  <- false-positive source
  unbounded-retry-loop       4          0     0%
  dismissal rate without those patterns: 53% -> 24%
```

## Which errors a retry can fix

| Error | Example | Retry? | Instead |
|---|---|---|---|
| Format | `14/03/2026`, `US dollars` | Yes: name the field, the rule and the bad value | |
| Structural | missing key, wrong type, no tool call | Yes | |
| Model arithmetic | `calculated_total` != sum of line items | Yes | |
| Source inconsistency | items sum to 1,150, document says 1,200 | No: the extraction is *correct* | `conflict_detected: true`, keep both totals, route to a human |
| Information absent | "PO number: see the attached purchase order" | No: it is not in this document | null + `po_number_missing_reason`; fetch the attachment if you can |

## Exam traps

- **"Retry up to N times"** is wrong as a blanket rule. Retries only fix output mistakes. When the value is not in the source, every retry costs money and returns the same null, or worse, a guess. Classify first.
- **The retry must carry the specifics.** "That was wrong, try again" gives the model nothing to work with. The follow-up has to include the document, the failed extraction and *which* field broke *which* rule (with the bad value).
- **A total mismatch is not always the model's fault.** Extracting both `stated_total` and `calculated_total` separates "the model added wrong" (retry) from "the invoice is wrong" (flag it). Without the pair you cannot tell the two apart.
- **Tool use / strict schemas do not catch semantic errors.** Sums and cross-field rules belong in your validator (see [D4.3](<../D4.3 - Structured Output with Tool Use and JSON Schemas/README.md>)).
- **Category-level dismissal stats hide the cause.** "bug" was 50% dismissed, which looks merely mixed. `detected_pattern` showed one construct (`broad-except-reraise`, 89%) causing most of it, next to a pattern nobody dismissed. Fix that criterion ([D4.1](<../D4.1 - Explicit Criteria to Reduce False Positives/README.md>)) or add an acceptable-pattern example ([D4.2](<../D4.2 - Few-Shot Prompting for Consistency and Quality/README.md>)). Do not drop the category.
- **Require a minimum sample size before acting.** A 3-finding pattern with one dismissal is noise.

## SDK notes

- The retry sends the errors as a `tool_result` with `is_error: true` that answers the failed `tool_use`. This keeps the conversation valid: every `tool_use` gets a result. Sending one fresh user message that contains `<document>`, `<failed_extraction>` and `<errors>` also works. The requirement is that all three are present.
- Live mode uses `tool_choice` auto with a prompt that names the tool (forced choice is a 400 on `claude-opus-5-5`). A response with no tool call is a *structural* issue, so it is retried like any other.

## Try this next

1. Add an INV-E whose PO number is printed in a footer ("Ref PO-88177") instead of on the `PO number:` line. `is_retryable` should allow a retry. Make the scripted model find it on the second attempt.
2. Give the scripted model an arithmetic slip on one invoice (wrong `calculated_total`) and check that the totals validator triggers a retry that succeeds.
3. Add week-3 findings after "fixing" `broad-except-reraise` (mostly accepted now) and show its dismissal rate falling below the threshold.
