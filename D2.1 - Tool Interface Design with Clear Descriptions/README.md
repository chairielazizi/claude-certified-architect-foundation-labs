# D2.1: Design effective tool interfaces with clear descriptions and boundaries

**Domain 2: Tool Design & MCP Integration (18%)** · Task Statement 2.1
**Exam scenarios:** Customer Support Resolution Agent, Multi-Agent Research System

## What the exam expects

| Knowledge | Skill |
|---|---|
| Tool descriptions are the main thing the model uses to pick a tool. Minimal descriptions make selection among similar tools unreliable | Write descriptions that separate each tool's purpose, inputs, outputs, and when to use it versus similar tools |
| A good description covers input formats, example queries, edge cases, and boundaries | Rename tools and rewrite descriptions to remove overlap (`analyze_content` becomes `extract_web_results`, with a web-specific description) |
| Ambiguous or overlapping descriptions cause misrouting (`analyze_content` vs `analyze_document`) | Split generic tools into purpose-specific tools with defined input/output contracts (`analyze_document` becomes `extract_data_points` + `summarize_content` + `verify_claim_against_source`) |
| System prompt wording affects selection: keyword-sensitive instructions can create tool associations nobody intended | Review system prompts for keyword-triggered instructions that override well-written descriptions |

## The pattern

```
description = what it does + what it RETURNS
            + Input: accepted formats (#48213, 48213, ORD-48213)
            + Use this when ... / Example queries: "..."
            + Edge case: what happens on not-found / empty / ambiguous input
            + Does not ... - use <sibling_tool> instead          <- the boundary

generic tool  --split-->  one tool per purpose, each with its own required inputs + output shape
vague name    --rename--> name says WHICH input (extract_web_results, not analyze_content)
system prompt --review--> state rules by intent ("before an account change"), never
                          "whenever the user mentions X, call Y"
```

## Files

| File | What it shows |
|---|---|
| `python/toolsets.py`, `typescript/toolsets.ts` | `BAD_TOOLS` (one-line descriptions, overlapping `analyze_*`, a generic `analyze_document`) and `GOOD_TOOLS` (expanded, renamed, split). Also two system prompts and 10 ambiguous test requests |
| `python/tool_lint.py`, `typescript/toolLint.ts` | Description linter (length, returns, input format, examples, when to use, when not to use, edge case, sibling reference, generic name, schema contract), Jaccard overlap detector, and system-prompt keyword linter |
| `python/lint_toolsets.py`, `typescript/lintToolsets.ts` | Runs all three reviews on both toolsets. 37 findings before, 0 after. Flags the `analyze_content`/`analyze_document` pair and the keyword-trap prompt |
| `python/selection_harness.py`, `typescript/selectionHarness.ts` | Selection accuracy with `tool_choice: auto` for BAD vs GOOD tools, and GOOD tools under a keyword-trap prompt. Offline it uses a description-sensitive stand-in model. With `--live` it calls the real API |

## Run it

```bash
python "D2.1 - Tool Interface Design with Clear Descriptions/python/lint_toolsets.py"
python "D2.1 - Tool Interface Design with Clear Descriptions/python/selection_harness.py"
npx tsx "D2.1 - Tool Interface Design with Clear Descriptions/typescript/lintToolsets.ts"
npx tsx "D2.1 - Tool Interface Design with Clear Descriptions/typescript/selectionHarness.ts"

# real model choosing between the same tool definitions (30 small calls)
python "D2.1 - Tool Interface Design with Clear Descriptions/python/selection_harness.py" --live
```

Expected offline output (abridged):

```
--- Why sample question 2 misroutes: evidence per tool for 'check my order #12345' ---
  BAD : [('get_customer', 1), ('lookup_order', 2), ('analyze_content', 0), ('analyze_document', 0)]
  GOOD: [('get_customer', -2), ('lookup_order', 4), ...]
--- A - BAD_TOOLS, reviewed prompt ---
  MISS check my order #12345            -> get_customer  (expected lookup_order)
  MISS Here are web search results ...  -> analyze_document  (expected analyze_content)
  accuracy: 5/10 = 50%
--- B - GOOD_TOOLS, reviewed prompt ---
  accuracy: 10/10 = 100%
--- C - GOOD_TOOLS, keyword-trap prompt ---
  MISS check my order #12345            -> get_customer  (expected lookup_order)
  MISS From these search engine snippets, which sources ... -> verify_claim_against_source
  accuracy: 7/10 = 70%
  [PASS] expanded descriptions route better (100% vs 50%)
  [PASS] keyword-sensitive prompt wording overrides good descriptions (unintended association)
```

## How the offline stand-in chooses (and why it is a fair illustration)

The scripted model does not know the answers. It reads the `tools` array in the request,
like Claude does, and scores each tool by evidence:

- **Positive evidence:** request words that appear in the tool name, description, or parameter docs. This includes identifier *shapes*: `#12345` matches a description that documents `#48213` as an accepted format.
- **Negative evidence:** words in boundary sentences ("Does not ...", "... instead"). A boundary pushes requests *away* from the tool.
- **Thin evidence:** if the best tool leads by less than 2, the descriptions don't separate the candidates, so the pick is a guess (the first-listed one). If no tool has any evidence, it answers in text.
- **Prompt rules:** keyword-triggered instructions in the system prompt fire on the keyword alone.

Claude understands language far better than this. The mechanism is the same, though: when
two descriptions offer the same thin evidence ("Retrieves ... details" + an untyped `Identifier`),
selection becomes unreliable, and better descriptions fix it. Run `--live` to measure the real
model on the same definitions. Expect it to be more forgiving than the stand-in on `BAD_TOOLS`.
Then check whether the keyword-trap prompt still pulls order questions toward `get_customer`.
The live numbers vary from run to run, so the accuracy checks only run offline.

## Before and after

| Before | Problem | After |
|---|---|---|
| `get_customer`: "Retrieves customer information" | No inputs, outputs, or boundary. Same `id: Identifier` schema as `lookup_order` | Returns profile fields. Input `C-1234`/email/phone. "A bare number like #12345 is an order number; send it to lookup_order instead" |
| `lookup_order`: "Retrieves order details" | Same | Documents `#48213 / 48213 / ORD-48213`, example queries, not-found edge case, boundary to `get_customer` |
| `analyze_content` / `analyze_document` | Jaccard similarity 0.6, so the model can't tell them apart | `extract_web_results` (search results only, "Not for PDFs ...") |
| `analyze_document` (does everything) | No output contract. Callers can't rely on the shape | `extract_data_points` -> `[{field, value, unit, page, quote}]`, `summarize_content` -> `{summary, key_points[], word_count}`, `verify_claim_against_source` -> `{verdict, evidence_quote, confidence}` |

## Exam traps

- **Sample Q2** (agent calls `get_customer` for "check my order #12345"; both tools have one-line descriptions): the right *first step* is **B, expand each tool's description** with input formats, example queries, edge cases, and boundaries. The descriptions are the root cause, and the fix is cheap and high-leverage. The distractors:
  - Few-shot examples (A) add tokens without fixing the root cause.
  - A keyword routing layer (C) is over-engineered and bypasses the model's language understanding.
  - Consolidating into `lookup_entity` (D) is a valid architecture, but too much work for a first step.
- A routing layer built on keywords recreates the keyword-trap problem in code. The trap prompt here shows how "whenever the user mentions an order" sends *every* order question to `get_customer`, even with excellent descriptions.
- Renaming matters as much as rewording. `analyze_content` and `analyze_document` stay confusable whatever their descriptions say, because the names collide. Rename to say *which* input the tool handles.
- Splitting a generic tool is about **contracts**, not just selection. Each split tool has its own required inputs and a documented output shape, so downstream code and the model know what comes back.
- Boundaries should name the sibling tool ("use lookup_order instead"). A plain "do not use for orders" doesn't tell the model where to go.
- A rule that must *always* hold (verify identity before a refund) belongs in programmatic enforcement. Don't use keyword prompt wording for it. See [D1.4](<../D1.4 - Multi-Step Workflows with Enforcement and Handoff/README.md>).

## Try this next

1. Add `get_order_history(customer_id)` to `GOOD_TOOLS`. Watch the overlap detector and the harness, then fix the boundaries between it, `lookup_order`, and `get_customer` until both are clean again.
2. Delete the boundary sentence from `get_customer` and re-run the harness. Which requests start to wobble, and why?
3. Run `selection_harness.py --live` a few times and compare the real model's misses on `BAD_TOOLS` with the stand-in's.
