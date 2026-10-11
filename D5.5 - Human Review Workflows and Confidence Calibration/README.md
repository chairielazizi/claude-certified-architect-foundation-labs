# D5.5: Design human review workflows and confidence calibration

**Domain 5: Context Management & Reliability (15%)** · Task Statement 5.5
**Exam scenarios:** Structured Data Extraction

## What the exam expects

| Knowledge | Skill |
|---|---|
| Aggregate accuracy (e.g. 97% overall) can mask poor performance on specific document types or fields | Analyse accuracy by document type and field to verify consistent performance across all segments before reducing human review |
| Field-level confidence scores, calibrated on labelled validation sets, route review attention | Have the model output field-level confidence, then calibrate review thresholds on a labelled validation set |
| Stratified random sampling measures error rates in high-confidence extractions and detects novel error patterns | Sample high-confidence extractions by stratum for ongoing error-rate measurement and new-pattern detection |
| Accuracy must be validated per document type and field before high-confidence extractions are automated | Route low-confidence extractions and ambiguous or contradictory source documents to human review, prioritising limited reviewer capacity |

## The pattern

```
labelled validation set --> accuracy by doc type x field        (never just the aggregate)
                       \--> per-segment threshold t*:  lowest t with precision(conf >= t) >= 99%,
                                                        >= 30 items above t, t >= 50
gate: segment has a t*?  yes -> reduce review above t*     no -> 100% human review

production extraction:
    contradictory source        -> human queue   (uncertainty = 100)
    segment failed the gate     -> human queue
    confidence < t*[segment]    -> human queue
    otherwise                   -> auto-accept
human queue sorted by RISK[field] x uncertainty; top N = reviewer capacity; the rest WAITS

auto-accepted pool -> stratified random sample (50 per doc type) -> error rate per stratum
                   -> errors clustered by (segment, layout) >= 3 -> novel-pattern alert
```

## Files

| File | What it shows |
|---|---|
| `python/review_data.py`, `typescript/reviewData.ts` | The mulberry32 PRNG (bit-identical in both languages), the labelled validation set and a production batch, calibration, routing and sampling helpers |
| `python/segment_accuracy.py`, `typescript/segmentAccuracy.ts` | 97.3% aggregate vs the doc type x field table, where `contract.effective_date` is 68% |
| `python/calibrate_thresholds.py`, `typescript/calibrateThresholds.ts` | Per-segment thresholds for 99% precision, the automation gate, and what a single global threshold would let through |
| `python/review_routing.py`, `typescript/reviewRouting.ts` | Production routing with reasons, a risk x uncertainty queue, and a reviewer capacity of 120 |
| `python/stratified_sampling.py`, `typescript/stratifiedSampling.ts` | Uniform vs stratified audits of the auto-accepted pool, and detection of a new failure mode the validation set never contained |

## Run it

```bash
python "D5.5 - Human Review Workflows and Confidence Calibration/python/segment_accuracy.py"
python "D5.5 - Human Review Workflows and Confidence Calibration/python/calibrate_thresholds.py"
python "D5.5 - Human Review Workflows and Confidence Calibration/python/review_routing.py"
python "D5.5 - Human Review Workflows and Confidence Calibration/python/stratified_sampling.py"
npx tsx "D5.5 - Human Review Workflows and Confidence Calibration/typescript/segmentAccuracy.ts"   # same numbers
```

These demos are pure computation (no model calls), so there is no `--live` mode. Both languages print the same fingerprint, for example `3200 extractions, 3112 correct, checksum 167522218`.

Expected output (abridged):

```
  accuracy 97.3% over 3200 extractions -> passes a 95% bar
  contract  effective_date    100     68.0%   <-- below the bar

  receipt.merchant_name         97.0%         78      99.0%        76.8%  automate at >= 78
  contract.effective_date       68.0%       none          -         0.0%  HUMAN REVIEW (gate failed)
  pooled calibration -> threshold 78, overall precision 99.0%
  contract.effective_date    precision at 78: 76.7% (56/73)  <-- misses the target

  auto-accepted      3238  (91.5% of extractions)
  reviewed today      120  (capacity 120); waiting 182

--- Uniform sample (150 checks) ---
  contract         145        8       1       12.5%   (too few to measure)
--- Stratified sample (150 checks) ---
  contract         145       50       5       10.0%   <-- above the 1% bar
  ALERT novel error pattern: contract.governing_law on layout scanned_v2 (5 sampled errors) -> pause auto-accept, re-validate
```

## Why each step exists

| Step | Failure it prevents |
|---|---|
| Accuracy by doc type x field | Automating a 68%-accurate field because the average is 97% |
| Per-segment thresholds | One global cut-off that is too strict for easy fields and too loose for hard ones (effective_date at 76.7%) |
| The gate | "Confidence >= t" being trusted for a segment where confident answers are often wrong |
| Contradictory sources to humans | High model confidence on a document that disagrees with itself |
| Risk x uncertainty ordering | Reviewers spending limited time on low-stakes, nearly-certain fields |
| Overflow waits | Capacity limits silently turning into auto-acceptance |
| Stratified sampling | Small strata (contracts, about 4% of volume) going unmeasured, and new failure modes going unseen |

## Exam traps

- **"97% accuracy, so reduce human review."** Aggregates hide segments. Here a 3%-of-volume field at 68% barely moves the average. Validate by document type and field first.
- **Raw confidence is not calibrated.** "Auto-accept above 0.9" is a guess until it is checked against labelled data. Calibrate per field, require enough items above the threshold, and re-calibrate when the input mix changes.
- **Some segments cannot be automated by thresholding.** When errors are as confident as correct answers, no threshold reaches the target. Keep that segment in human review and fix the extraction (for example with few-shot examples for ambiguous dates, see [D4.2](<../D4.2 - Few-Shot Prompting for Consistency and Quality/README.md>)).
- **Uniform random sampling is not enough.** It gave contracts 8 checks out of 150 and missed the new failure mode. Stratified sampling gives every stratum a measurable sample.
- **High confidence does not mean correct forever.** A new template produced confidently wrong `governing_law` values that passed the calibrated threshold. Ongoing sampling of auto-accepted output is what catches it.
- **Limited capacity is a prioritisation problem.** Order by risk x uncertainty, and let the overflow wait. Do not lower the bar to clear the queue.
- Self-reported confidence is also covered in [D4.6](<../D4.6 - Multi-Instance and Multi-Pass Review Architectures/README.md>) (verification passes) and [D5.2](<../D5.2 - Escalation and Ambiguity Resolution Patterns/README.md>) (why confidence is a poor escalation proxy).

## Try this next

1. Raise `TARGET_PRECISION_PCT` to 99.5 (use per-mille in the integer comparison) and watch coverage drop per segment.
2. Set `PER_STRATUM` to 20. Does the stratified audit still raise the alert? What does that say about audit sample size?
3. Split the validation set into calibration and holdout halves, calibrate on one and measure precision on the other, to see how much the thresholds overfit.
