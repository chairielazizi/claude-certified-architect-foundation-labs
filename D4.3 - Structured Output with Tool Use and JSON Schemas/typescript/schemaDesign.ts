/**
 * D4.3 - Schema design decides what the model is ALLOWED to say.
 *
 *   required non-null field, absent from the document -> the model invents a value
 *   nullable field                                      -> null, nothing fabricated
 *   enum without "other"                                -> forced into a wrong bucket
 *   enum + "other" + category_detail                    -> extensible, nothing lost
 *   enum + "unclear"                                    -> ambiguity admitted, not guessed
 *   format rules in the prompt                          -> ISO dates, ISO 4217 currency
 *
 * Every extraction is read from the tool_use block's .input and parsed with zod.
 *
 * Run:  npx tsx schemaDesign.ts          (offline, scripted model)
 *       npx tsx schemaDesign.ts --live   (real Claude API; forced tool_choice uses FORCED_TOOL_CHOICE_MODEL)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  Invoice,
  SYSTEM_BASE,
  SYSTEM_WITH_RULES,
  asTools,
  doc,
  documentMessage,
  firstToolUse,
  invoiceTool,
  type ToolDef,
} from "./extractionTools.ts";
import { scriptedExtractor } from "./scriptedExtractor.ts";

const client = lab.getClient(scriptedExtractor);
const offline = !lab.isLive();

async function extract(docId: string, tool: ToolDef, system: string = SYSTEM_WITH_RULES): Promise<Invoice> {
  const response = await client.messages.create({
    model: lab.FORCED_TOOL_CHOICE_MODEL, // forced tool_choice is a 400 on claude-opus-5-5
    max_tokens: 4000,
    system,
    tools: asTools([tool]),
    tool_choice: { type: "tool", name: "extract_invoice" },
    messages: [{ role: "user", content: documentMessage(doc(docId)) }],
  });
  const block = firstToolUse(response);
  if (!block) throw new Error("forced tool_choice must return a tool_use block");
  return Invoice.parse(block.input); // tool input is already an object: no JSON.parse
}

const q = (v: unknown) => JSON.stringify(v);

lab.banner("D4.3  Schema design: nullable, other + detail, unclear, format rules");

lab.section("A. Field absent from the document (inv-002 has no date, no PO)");
const good = await extract("inv-002", invoiceTool());
const bad = await extract("inv-002", invoiceTool({ nullableFields: false }));
console.log(`  nullable schema : invoice_date=${q(good.invoice_date).padEnd(14)} po_number=${q(good.po_number)}`);
console.log(`  required strings: invoice_date=${q(bad.invoice_date).padEnd(14)} po_number=${q(bad.po_number)}`);
lab.check(good.invoice_date === null && good.po_number === null, "nullable fields: the model returns null instead of inventing");
if (offline) {
  const source = doc("inv-002").text;
  lab.check(
    bad.invoice_date !== null && !source.includes(bad.invoice_date) && bad.po_number === bad.invoice_number,
    "required non-null fields: a date that is not in the document, and the invoice number reused as PO",
  );
}

lab.section("B. Category not in the list (inv-003, catering)");
const withOther = await extract("inv-003", invoiceTool());
const withoutOther = await extract("inv-003", invoiceTool({ withOther: false, withUnclear: false }));
console.log(`  enum + other : category=${q(withOther.category)} category_detail=${q(withOther.category_detail)}`);
console.log(`  enum only    : category=${q(withoutOther.category)} category_detail=${q(withoutOther.category_detail)}`);
if (offline) {
  lab.check(withOther.category === "other" && withOther.category_detail === "event catering", '"other" + detail keeps the real category');
  lab.check(withoutOther.category === "travel", "without 'other' the spend is silently misfiled");
}

lab.section('C. Not enough information to categorize (inv-004, "Q3 services bundle")');
const withUnclear = await extract("inv-004", invoiceTool());
const withoutUnclear = await extract("inv-004", invoiceTool({ withUnclear: false }));
console.log(`  enum + unclear: ${q(withUnclear.category)}`);
console.log(`  no unclear    : ${q(withoutUnclear.category)}  (other needs a detail it does not have)`);
if (offline) {
  lab.check(withUnclear.category === "unclear", '"unclear" lets the model flag ambiguity for review');
  lab.check(withoutUnclear.category !== "unclear" && withoutUnclear.category !== "other", "without it, a guess looks exactly like a fact");
}

lab.section("D. Format normalization rules in the prompt");
for (const docId of ["inv-001", "inv-004"]) {
  const raw = await extract(docId, invoiceTool(), SYSTEM_BASE);
  const norm = await extract(docId, invoiceTool(), SYSTEM_WITH_RULES);
  console.log(`  ${docId} no rules  : invoice_date=${q(raw.invoice_date).padEnd(16)} currency=${q(raw.currency)}`);
  console.log(`  ${docId} with rules: invoice_date=${q(norm.invoice_date).padEnd(16)} currency=${q(norm.currency)}`);
  if (offline) {
    lab.check(
      raw.invoice_date !== norm.invoice_date && norm.invoice_date !== null && norm.invoice_date.length === 10,
      `${docId}: the schema allowed any string; the prompt rule produced ISO 8601`,
    );
    lab.check(/^[A-Z]{3}$/.test(norm.currency), `${docId}: currency normalized to an ISO 4217 code`);
  }
}
