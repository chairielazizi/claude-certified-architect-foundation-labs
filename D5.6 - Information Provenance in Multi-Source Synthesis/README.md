# D5.6: Preserve information provenance and handle uncertainty in multi-source synthesis

**Domain 5: Context Management & Reliability (15%)** · Task Statement 5.6
**Exam scenarios:** Multi-Agent Research System

## What the exam expects

| Knowledge | Skill |
|---|---|
| Source attribution is lost when summarization compresses findings without keeping claim-source mappings | Require subagents to output structured claim-source mappings (source URL, document name, relevant excerpt) that downstream agents preserve through synthesis |
| The synthesis agent must preserve and merge structured claim-source mappings | Structure reports with explicit sections for well-established and contested findings, keeping the original source characterisations and methodological context |
| Conflicting statistics from credible sources should be annotated with attribution, not resolved by picking one value | Complete document analysis with conflicting values included and annotated, and let the coordinator decide how to reconcile before synthesis |
| Temporal data needs publication / collection dates so that differences over time are not read as contradictions | Require publication or data-collection dates in structured outputs; render each content type appropriately (financial data as tables, news as prose, technical findings as lists) |

## The pattern

```
subagent output = [{claim_key, claim, value, unit, evidence_excerpt, source_url, document_name,
                    publication_date, data_collection_period, methodology}, ...]

merge:     group by claim_key, then by value       same claim, 2 sources -> 1 finding, 2 citations
classify:  1 value                                -> established
           values differ, periods do not overlap  -> temporal   (a trend, NOT a contradiction)
           values differ, same period             -> conflict   (keep BOTH, annotated, "unresolved")
coordinator: record_reconciliation(claim_key, report_both_with_methodology | prefer_source | seek_third_source)
report:    ## Well-established   ### Financial data (table)  ### News (prose)  ### Technical findings (list)
           ## Contested          both values, both sources, methodology, coordinator decision
           ## Coverage gaps      requested subtopics with no sourced claim
           ## Sources            [S#] document, URL, published, data period, method
```

## Files

| File | What it shows |
|---|---|
| `fixtures/subagent_outputs.json` | 12 claim-source mappings from 3 subagents: an agreeing pair, a same-period conflict, a temporal pair, news and technical claims, and one requested subtopic nobody covered |
| `python/provenance.py`, `typescript/provenance.ts` | Merge, classification, the coordinator's `record_reconciliation` tool, the naive summarizer, the report renderer and the report parsers used by the checks |
| `python/naive_vs_provenance.py`, `typescript/naiveVsProvenance.ts` | A "summarize into one paragraph" step vs the merged claim-source table |
| `python/conflicts_and_temporal.py`, `typescript/conflictsAndTemporal.ts` | Classification, the annotated conflict handed to the coordinator, and its reconciliation decision |
| `python/provenance_report.py`, `typescript/provenanceReport.ts` | The final report with sections, content-type rendering and a sources list, plus checks on every claim |

## Run it

```bash
python "D5.6 - Information Provenance in Multi-Source Synthesis/python/naive_vs_provenance.py"
python "D5.6 - Information Provenance in Multi-Source Synthesis/python/conflicts_and_temporal.py"
python "D5.6 - Information Provenance in Multi-Source Synthesis/python/provenance_report.py"
npx tsx "D5.6 - Information Provenance in Multi-Source Synthesis/typescript/provenanceReport.ts"
python "D5.6 - Information Provenance in Multi-Source Synthesis/python/provenance_report.py" --live   # real coordinator
```

Expected offline output (abridged):

```
--- A - naive: summarize the findings into one paragraph ---
The global market for AI-generated music was worth USD 3.9 bn in 2025. AI music startups raised USD 1.2 bn in
the first half of 2026. AI-assisted tracks earned 4% of streaming revenue. ...
--- B - provenance-preserving merge ---
  market_size_2025           3.9 USD bn                   [S1] [S4]  period 2025-01..2025-12
  ai_music_funding_2026h1    1.2 USD bn                   [S2]       period 2026-01..2026-06
  ai_music_funding_2026h1    0.8 USD bn                   [S5]       period 2026-01..2026-06

  conflict     ai_music_funding_2026h1    1.2 (2026-01..2026-06); 0.8 (2026-01..2026-06)
  temporal     ai_track_streaming_share   4 (2024-01..2024-12); 9 (2026-01..2026-06)

## Contested findings
- AI music startup funding (2026-01..2026-06): 1.2 USD bn per PitchData Funding Monitor Q2 2026 [S2] (All disclosed
  equity and convertible rounds of USD 1M or more) vs 0.8 USD bn per VentureWatch H1 2026 Report [S5] (Equity rounds
  only; excludes convertible notes). Coordinator decision: report_both_with_methodology. ...
## Coverage gaps
- session musician employment: no subagent returned a sourced claim.
```

## What each step protects

| Step | What goes wrong without it |
|---|---|
| Structured claim-source mappings from subagents | Synthesis receives prose; the source of each statement cannot be recovered |
| Merge by claim, keep every citation | Corroboration is invisible, or duplicate claims appear as separate findings |
| Dates and data periods in every mapping | 4% (2024) vs 9% (2026-H1) looks like a contradiction, or the newer figure is dropped as noise |
| Annotate conflicts, let the coordinator reconcile | The analysis step silently picks 1.2 or 0.8, with no record that the other existed |
| Contested section with methodology | Readers cannot see why credible sources differ (equity-only vs including convertibles) |
| Coverage gaps section | A missing subtopic reads as "nothing to report" |
| Content-appropriate rendering | Numbers buried in prose, or news chopped into context-free bullets |

## Exam traps

- **"Summarize the findings" is where provenance dies.** The naive summary reads well and cites nothing. It also kept 1.2 and dropped 0.8 without saying so, and it kept the outdated 4% while losing its period. Carry structured mappings through synthesis instead of compressing them into text.
- **Do not resolve conflicts by picking a value.** When credible sources disagree, report both values with their sources and methodology, and record the coordinator's reconciliation decision. Averaging or choosing the "more recent" or "bigger" source hides the uncertainty.
- **Different periods are not contradictions.** Without `data_collection_period`, 4% vs 9% looks like a conflict. With it, it is a trend. This is why subagents must emit publication and collection dates.
- **Corroboration is information.** Two agreeing sources should show up as one finding with two citations, not as two findings or as one uncited finding.
- **Do not force one format.** Financial figures belong in a table with periods and sources; news reads best as cited prose; technical results as a list with methodology.
- **Report coverage gaps explicitly.** "No sourced claim for session musician employment" is a finding the reader needs. The same principle drives coverage annotations in [D5.3](<../D5.3 - Error Propagation Across Multi-Agent Systems/README.md>), and metadata requirements for subagent outputs appear in [D5.1](<../D5.1 - Preserving Critical Context in Long Interactions/README.md>).

## Try this next

1. Add a third funding source that agrees with PitchData's methodology and value. Does the coordinator still choose `report_both_with_methodology`? Should it?
2. Remove `data_collection_period` from the two streaming claims and re-run `conflicts_and_temporal.py`. Watch the trend turn into a conflict.
3. Run `naive_vs_provenance.py --live` and count how many sources the real model keeps when asked for "one concise paragraph".
