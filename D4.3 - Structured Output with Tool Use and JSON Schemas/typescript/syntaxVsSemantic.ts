/**
 * D4.3 - Tool use removes JSON SYNTAX errors; it does not remove SEMANTIC errors.
 *
 *   "return JSON" in the prompt -> prose + ``` fences + trailing commas -> JSON.parse fails
 *   strict tool use             -> tool_use.input is always schema-valid -> 0 syntax errors
 *   ...but schema-valid != correct: line items that don't add up, a PO number sitting in
 *   invoice_number. A local semantic validator has to catch those.
 *
 * Run:  npx tsx syntaxVsSemantic.ts          (offline, scripted model)
 *       npx tsx syntaxVsSemantic.ts --live   (real Claude API)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  INVOICE_TOOL,
  Invoice,
  SYSTEM_WITH_RULES,
  asTools,
  doc,
  documentMessage,
  firstToolUse,
  semanticErrors,
} from "./extractionTools.ts";
import { scriptedExtractor } from "./scriptedExtractor.ts";

const DOC_IDS = ["inv-001", "inv-004", "inv-005"];

function tryParse(text: string): [boolean, string] {
  try {
    JSON.parse(text);
    return [true, "ok"];
  } catch (err) {
    return [false, (err as Error).message.slice(0, 60)];
  }
}

/** The usual band-aid: cut out the ```json block. Still fails on hand-written JSON errors. */
function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  return m ? m[1] : text;
}

lab.banner("D4.3  Syntax errors vs semantic errors");
const client = lab.getClient(scriptedExtractor);

lab.section('A. No tools, "Return the invoice as JSON" in the prompt');
let naiveFailures = 0;
let cleanedFailures = 0;
for (const docId of DOC_IDS) {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 4000,
    system: SYSTEM_WITH_RULES + "\nReturn the invoice as a JSON object.",
    messages: [{ role: "user", content: documentMessage(doc(docId)) }],
  });
  const text = lab.textOf(response);
  const [okNaive, whyNaive] = tryParse(text);
  const [okClean, whyClean] = tryParse(stripFences(text));
  if (!okNaive) naiveFailures++;
  if (!okClean) cleanedFailures++;
  console.log(`  ${docId}: JSON.parse -> ${whyNaive.padEnd(40)} after stripping fences -> ${whyClean}`);
}
console.log(`  syntax failures: ${naiveFailures}/3 raw, ${cleanedFailures}/3 even after clean-up`);

lab.section("B. Strict tool use: read tool_use.input");
const parsed: Record<string, Invoice> = {};
for (const docId of DOC_IDS) {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 4000,
    system: SYSTEM_WITH_RULES,
    tools: asTools([INVOICE_TOOL]), // strict: true -> input is guaranteed to match input_schema
    messages: [{ role: "user", content: documentMessage(doc(docId)) }],
  });
  const block = firstToolUse(response);
  if (block) parsed[docId] = Invoice.parse(block.input);
  console.log(`  ${docId}: ${block ? "schema-valid input" : "NO tool_use (auto mode - see modernStructuredOutput.ts)"}`);
}

lab.section("C. Semantic validation of the schema-valid output");
for (const [docId, inv] of Object.entries(parsed)) {
  const errors = semanticErrors(inv);
  console.log(`  ${docId}: ${errors.length ? JSON.stringify(errors) : "no semantic errors"}`);
}

if (!lab.isLive()) {
  lab.check(naiveFailures === 3, "JSON-in-text: every reply needs post-processing (prose and fences around the JSON)");
  lab.check(cleanedFailures >= 1, "stripping fences is not enough: hand-written JSON still has syntax errors");
  lab.check(Object.keys(parsed).length === 3, "tool use: all 3 extractions parsed with zero syntax errors");
  const inv5 = semanticErrors(parsed["inv-005"]);
  lab.check(inv5.some((e) => e.includes("sum to")), "...yet inv-005's line items (1,150) do not add up to its total (1,200)");
  lab.check(inv5.some((e) => e.includes("purchase-order")), "...and a PO number landed in invoice_number (value in the wrong field)");
  lab.check(
    semanticErrors(parsed["inv-001"]).length === 0 && semanticErrors(parsed["inv-004"]).length === 0,
    "clean documents pass the semantic checks",
  );
}
