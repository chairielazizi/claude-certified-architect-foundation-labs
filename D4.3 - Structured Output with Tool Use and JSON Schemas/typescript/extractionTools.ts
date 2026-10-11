/**
 * Extraction tools for D4.3: the tool's input_schema IS the output schema.
 *
 * Design choices shown here:
 *  - every property is listed in "required" and objects set additionalProperties: false (what
 *    strict: true expects); "optional" is expressed as NULLABLE, so the model can say "not in
 *    the document" instead of inventing a value
 *  - enum + "other" + category_detail for extensible categories, plus "unclear"
 *  - format rules (ISO dates, ISO 4217 currency) live in the PROMPT, next to the schema: a schema
 *    can say "string", it cannot say which of five date spellings to use
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export interface ObjectSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: false;
}

export interface ToolDef {
  name: string;
  description: string;
  strict: boolean;
  input_schema: ObjectSchema;
}

export interface Doc {
  id: string;
  note: string;
  absent: string[];
  text: string;
}

export const DOCS: Doc[] = (
  JSON.parse(readFileSync(new URL("../fixtures/documents.json", import.meta.url), "utf-8")) as { documents: Doc[] }
).documents;

export function doc(id: string): Doc {
  const found = DOCS.find((d) => d.id === id);
  if (!found) throw new Error(`no document ${id}`);
  return found;
}

export function documentMessage(d: Doc, instruction = ""): string {
  return `${instruction}\n<document>\n${d.text}\n</document>`.trimStart();
}

/** Tool definitions as the SDK type for the `tools` request field. */
export function asTools(defs: ToolDef[]): Anthropic.Tool[] {
  return defs as unknown as Anthropic.Tool[];
}

export const SYSTEM_BASE = "You extract data from business documents by calling the matching extraction tool.";

export const FORMAT_RULES = `Rules:
- Use only information in the document. If a field is not in the document, use null. Never guess.
- Dates: ISO 8601 (YYYY-MM-DD). Numeric dates in these documents are day/month/year.
- currency: ISO 4217 code. "$" means USD; "EUR" and "GBP" are already codes.
- Amounts: plain numbers, no currency symbols or thousands separators.
- category: if none fits, use "other" and say what it is in category_detail; if the document
  does not say enough to choose, use "unclear".`;

export const SYSTEM_WITH_RULES = `${SYSTEM_BASE}\n\n${FORMAT_RULES}`;

/** anyOf [T, null] is the nullable form structured outputs / strict tools accept. */
export function nullable(schema: JsonSchema, description: string): JsonSchema {
  return { anyOf: [schema, { type: "null" }], description };
}

function obj(properties: Record<string, JsonSchema>): ObjectSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const CATEGORIES = ["office_supplies", "software", "hardware", "professional_services", "travel"];

/** extract_invoice. The option flags build the "bad design" variants for comparison. */
export function invoiceTool(opts: { nullableFields?: boolean; withOther?: boolean; withUnclear?: boolean } = {}): ToolDef {
  const { nullableFields = true, withOther = true, withUnclear = true } = opts;
  const maybeNull = (schema: JsonSchema, description: string) =>
    nullableFields ? nullable(schema, description) : { ...schema, description };
  const categoryEnum = [...CATEGORIES, ...(withOther ? ["other"] : []), ...(withUnclear ? ["unclear"] : [])];
  const lineItem = obj({
    description: { type: "string" },
    quantity: { type: "number" },
    unit_price: { type: "number" },
    amount: { type: "number" },
  });
  return {
    name: "extract_invoice",
    description: "Record the fields of a supplier INVOICE. Call once per invoice.",
    strict: true,
    input_schema: obj({
      vendor_name: { type: "string", description: "Supplier name as printed. Always present on an invoice." },
      invoice_number: nullable({ type: "string" }, "The supplier's invoice number. Not a PO number."),
      invoice_date: maybeNull({ type: "string" }, "Invoice date, YYYY-MM-DD; null if not stated."),
      po_number: maybeNull({ type: "string" }, "Buyer's purchase-order number; null if not stated."),
      currency: { type: "string", description: "ISO 4217 code, e.g. USD." },
      category: { type: "string", enum: categoryEnum },
      category_detail: nullable({ type: "string" }, "What the spend is when category is 'other'."),
      line_items: { type: "array", items: lineItem },
      total: { type: "number", description: "Total due as printed." },
    }),
  };
}

export const RECEIPT_TOOL: ToolDef = {
  name: "extract_receipt",
  description: "Record the fields of a point-of-sale RECEIPT (shop, cafe, taxi).",
  strict: true,
  input_schema: obj({
    merchant: { type: "string" },
    date: nullable({ type: "string" }, "YYYY-MM-DD; null if not printed."),
    currency: nullable({ type: "string" }, "ISO 4217 code; null if the receipt shows none."),
    items: { type: "array", items: obj({ description: { type: "string" }, amount: { type: "number" } }) },
    total: { type: "number" },
    payment_method: { type: "string", enum: ["card", "cash", "other", "unclear"] },
  }),
};

export const CONTRACT_TOOL: ToolDef = {
  name: "extract_contract",
  description: "Record the key terms of a CONTRACT or agreement.",
  strict: true,
  input_schema: obj({
    title: { type: "string" },
    parties: { type: "array", items: obj({ name: { type: "string" }, role: { type: "string" } }) },
    effective_date: nullable({ type: "string" }, "YYYY-MM-DD; null if not stated."),
    term_months: nullable({ type: "integer" }, "Contract term in months; null if open-ended or not stated."),
    governing_law: nullable({ type: "string" }, "Jurisdiction; null if not stated."),
  }),
};

export const METADATA_TOOL: ToolDef = {
  name: "extract_metadata",
  description: "Classify a document before any detailed extraction. Always the first step of the pipeline.",
  strict: true,
  input_schema: obj({
    doc_type: { type: "string", enum: ["invoice", "receipt", "contract", "other", "unclear"] },
    language: { type: "string", description: "ISO 639-1 code" },
    has_signature: { type: "boolean" },
    mentions_amounts: { type: "boolean" },
  }),
};

export const INVOICE_TOOL = invoiceTool();
export const EXTRACTION_TOOLS: ToolDef[] = [INVOICE_TOOL, RECEIPT_TOOL, CONTRACT_TOOL];

// ---------------------------------------------------------------------------
// Typed parsing of tool input + semantic validation
// ---------------------------------------------------------------------------

export const LineItem = z.strictObject({
  description: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  amount: z.number(),
});

/** Mirrors extract_invoice's schema. Parsing proves SHAPE, not correctness. */
export const Invoice = z.strictObject({
  vendor_name: z.string(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  po_number: z.string().nullable(),
  currency: z.string(),
  category: z.enum(["office_supplies", "software", "hardware", "professional_services", "travel", "other", "unclear"]),
  category_detail: z.string().nullable(),
  line_items: z.array(LineItem),
  total: z.number(),
});
export type Invoice = z.infer<typeof Invoice>;

/** Checks a JSON schema cannot express. Strict tool use guarantees none of these. */
export function semanticErrors(inv: Invoice): string[] {
  const errors: string[] = [];
  inv.line_items.forEach((item, i) => {
    if (Math.abs(item.quantity * item.unit_price - item.amount) > 0.01) {
      errors.push(`line_items[${i}]: ${item.quantity} x ${item.unit_price} != ${item.amount}`);
    }
  });
  const itemsSum = Math.round(inv.line_items.reduce((s, item) => s + item.amount, 0) * 100) / 100;
  if (Math.abs(itemsSum - inv.total) > 0.01) {
    errors.push(`line items sum to ${itemsSum.toFixed(2)} but total is ${inv.total.toFixed(2)}`);
  }
  if (inv.invoice_number && /^PO-/.test(inv.invoice_number)) {
    errors.push(`invoice_number ${JSON.stringify(inv.invoice_number)} looks like a purchase-order number (wrong field?)`);
  }
  if (inv.category === "other" && !inv.category_detail) errors.push("category is 'other' but category_detail is empty");
  if (inv.invoice_date && !/^\d{4}-\d{2}-\d{2}$/.test(inv.invoice_date)) {
    errors.push(`invoice_date ${JSON.stringify(inv.invoice_date)} is not YYYY-MM-DD`);
  }
  if (!/^[A-Z]{3}$/.test(inv.currency)) errors.push(`currency ${JSON.stringify(inv.currency)} is not an ISO 4217 code`);
  return errors;
}

/** The structured data lives in the tool_use block's .input (already parsed JSON). */
export function firstToolUse(response: Anthropic.Message): Anthropic.ToolUseBlock | null {
  return response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use") ?? null;
}
