# D4.3: Enforce structured output using tool use and JSON schemas

**Domain 4: Prompt Engineering & Structured Output (20%)** · Task Statement 4.3
**Exam scenarios:** Structured Data Extraction

## What the exam expects

| Knowledge | Skill |
|---|---|
| Tool use with JSON schemas is the most reliable way to get schema-compliant structured output, and it eliminates JSON syntax errors | Define extraction tools whose `input_schema` is the output schema, and read the data from the `tool_use` block |
| `tool_choice`: `"auto"` (may return text), `"any"` (must call a tool, picks which), forced `{"type": "tool", "name": ...}` (must call that tool) | Use `"any"` when there are several extraction schemas and the document type is unknown |
| Strict schemas prevent syntax errors, not semantic ones (line items that don't sum to the total, values in the wrong field) | Force `extract_metadata` so it runs before the enrichment steps |
| Schema design: required vs optional fields, enum + `"other"` + detail string for extensible categories | Make fields nullable when the source may not contain them, so the model does not invent values |
| | Add `"unclear"` for ambiguous cases and `"other"` + detail for extensible categories. Put format-normalization rules in the prompt alongside the schema |

## The pattern

```
tools = [extract_invoice, extract_receipt, extract_contract]   # input_schema = output schema
          strict: true, additionalProperties: false
          vendor_name: string                     <- always present: required, non-null
          po_number:  anyOf [string, null]        <- may be absent: nullable, so null not invented
          category:   enum [..., "other", "unclear"] + category_detail: nullable string
system = "... Dates YYYY-MM-DD, currency ISO 4217, null if absent ..."  <- normalization rules

doc type unknown        -> tool_choice {"type": "any"}                       (must call one)
metadata must run first -> tool_choice {"type": "tool", "name": "extract_metadata"}
                           then a follow-up turn forced to the tool routed from the metadata
data = response.content[i].input      (tool_use block; already parsed, schema-valid)
semantic_errors(data)                 (sum of line items, field placement: code, not schema)
```

## Files

| File | What it shows |
|---|---|
| `fixtures/documents.json` | 6 invoices, 1 receipt, 1 contract. One lacks a date and PO, one has an off-list category, one is ambiguous, one is schema-valid but wrong, one asks the reader a question |
| `python/extraction_tools.py`, `typescript/extractionTools.ts` | The four tool schemas (plus the "bad design" variants), the normalization rules, the pydantic / zod `Invoice` model, and `semantic_errors()` |
| `python/scripted_extractor.py`, `typescript/scriptedExtractor.ts` | Offline model that follows `tool_choice` semantics, honours nullability and enums from the schema, and normalizes only when the prompt says how |
| `python/tool_choice_modes.py`, `typescript/toolChoiceModes.ts` | `auto` returns text; `any` picks the right schema per document; forced `extract_metadata`, then a forced enrichment follow-up turn |
| `python/schema_design.py`, `typescript/schemaDesign.ts` | Nullable vs required (fabrication), `other` + detail, `unclear`, normalization rules on and off |
| `python/syntax_vs_semantic.py`, `typescript/syntaxVsSemantic.ts` | JSON-in-text fails to parse; tool use parses every time; the semantic validator still finds two errors in a schema-valid extraction |
| `python/modern_structured_output.py`, `typescript/modernStructuredOutput.ts` | The `claude-opus-5-5` way: `output_config.format`, and `strict` tool + `auto` + verify / re-prompt |

## Run it

```bash
python "D4.3 - Structured Output with Tool Use and JSON Schemas/python/tool_choice_modes.py"
python "D4.3 - Structured Output with Tool Use and JSON Schemas/python/schema_design.py"
python "D4.3 - Structured Output with Tool Use and JSON Schemas/python/syntax_vs_semantic.py"
python "D4.3 - Structured Output with Tool Use and JSON Schemas/python/modern_structured_output.py"
npx tsx "D4.3 - Structured Output with Tool Use and JSON Schemas/typescript/toolChoiceModes.ts"
npx tsx "D4.3 - Structured Output with Tool Use and JSON Schemas/typescript/schemaDesign.ts"
npx tsx "D4.3 - Structured Output with Tool Use and JSON Schemas/typescript/syntaxVsSemantic.ts"
npx tsx "D4.3 - Structured Output with Tool Use and JSON Schemas/typescript/modernStructuredOutput.ts"

# live: forced/any calls go to LAB_FORCED_TOOL_MODEL (default claude-opus-5), the rest to claude-opus-5-5
python "D4.3 - Structured Output with Tool Use and JSON Schemas/python/tool_choice_modes.py" --live
```

Expected offline output (abridged):

```
--- A. tool_choice {"type": "auto"}: the model may just talk ---
  stop_reason=end_turn  text='Got it - document type: invoice. Want me to pull out the details?'
--- B. tool_choice {"type": "any"}: unknown document type, three schemas ---
  inv-001   -> extract_invoice   {"vendor_name": "Northwind Office Supply", ...
  rcpt-001  -> extract_receipt   {"merchant": "CITY CAFE", "date": "2026-03-12", "currency": null, ...
  ctr-001   -> extract_contract  {"title": "Master Services Agreement", ...
--- A. Field absent from the document (inv-002 has no date, no PO) ---
  nullable schema : invoice_date=None           po_number=None
  required strings: invoice_date='2026-03-01'   po_number='BP-7781'
--- A. No tools, "Return the invoice as JSON" in the prompt ---
  syntax failures: 3/3 raw, 2/3 even after clean-up
--- C. Semantic validation of the schema-valid output -------
  inv-005: ['line items sum to 1150.00 but total is 1200.00', "invoice_number 'PO-7781' looks like a purchase-order number (wrong field?)"]
```

## What each guarantee covers

| Mechanism | Guarantees | Does not guarantee |
|---|---|---|
| "Respond in JSON" in the prompt | Nothing (prose, fences, trailing commas) | Parseable output |
| Tool use + `input_schema` (`strict: true`) | Parseable, schema-valid `input` | That a tool is called (under `auto`), correct values |
| `tool_choice: "any"` | *Some* tool is called | Which one (the model picks) |
| Forced `{"type": "tool", "name": X}` | X is called, so ordering such as metadata first holds | Values are right |
| `output_config.format` json_schema | The text block is schema-valid JSON | Values are right |
| Nullable field + "null if absent" rule | The model has an honest option | (Required non-null fields push it to invent) |
| Your semantic validator | Sums, cross-field rules, field placement | Anything you did not code |

## Exam traps

- **"Ask for JSON in the prompt and parse it"** is never the most reliable option. Tool use (or structured outputs) removes syntax errors. Regex or fence-stripping band-aids still fail (2 of 3 here).
- **`auto` does not guarantee structured output.** The model may reply in text, and it did here twice: once when no one mentioned tools, once when the document asked a question. Use `any` or forced, or verify and re-prompt.
- **`any` vs forced:** use `any` when you do not know which schema applies. Use forced when one specific step must run, for example `extract_metadata` before enrichment. The next step goes in a **follow-up turn** after you return the `tool_result`.
- **Schema-valid is not correct.** The exam's examples are line items that don't sum to the total and values in the wrong field. Validate them in code, then retry with the errors ([D4.4](<../D4.4 - Validation Retry and Feedback Loops/README.md>)).
- **Required fields cause fabrication.** If the document may not contain a value, make it nullable and tell the model to use null. A required `string` for an absent PO number got the invoice number copied into it.
- **Enums need escape hatches.** Without `"other"` (plus a detail string), catering was misfiled as travel. Without `"unclear"`, an ambiguous invoice got a confident-looking guess.
- **The schema says type, the prompt says format.** `"type": "string"` accepted both `March 4, 2026` and `$`. The normalization rules produced `2026-03-04` and `USD`.

## SDK notes

- **Forced tool use drift.** `tool_choice` `{"type": "any"}` and `{"type": "tool", ...}` return **HTTP 400** on `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1`. The exam still tests them, so these labs send those calls to `lab.FORCED_TOOL_CHOICE_MODEL` (env `LAB_FORCED_TOOL_MODEL`, default `claude-opus-5`). On current models, use one of the two patterns in `modern_structured_output.py`:
  1. `output_config={"format": {"type": "json_schema", "schema": ...}}` on `messages.create`. The first text block is valid JSON. Python also has `client.messages.parse(..., output_format=PydanticModel)`. Do not use the deprecated top-level `output_format` on `create`.
  2. `strict: true` on the tool, `tool_choice` `auto`, a prompt that names the tool, and a check that a `tool_use` came back (re-prompt if not).
- Strict tools and structured outputs need `additionalProperties: false` on every object. They do not support every JSON Schema keyword (for example `minLength`, `minimum`). Nullable fields use `anyOf: [{...}, {"type": "null"}]`.
- Read tool output from `block.input`. It is already a dict / object. Never string-match the serialized JSON.

## Try this next

1. Add an `extract_purchase_order` tool and a PO document. Check that `tool_choice: "any"` picks it without changing any other code.
2. Remove `"Never guess"` and the null rule from `FORMAT_RULES`, keep the nullable schema, and run `schema_design.py --live`. Does the real model still return null for inv-002?
3. Extend `semantic_errors()` with "invoice_date must not be in the future", and add a document that triggers it.
