/**
 * Validation for D4.4: zod schema with semantic refinements + retryable/not-retryable triage.
 *
 * The extraction carries BOTH stated_total (what the document says) and calculated_total (what
 * the line items add up to) plus conflict_detected. That turns "the numbers disagree" into data:
 *   - model arithmetic wrong     -> calculated_total != sum(items) -> retry with the error
 *   - the SOURCE is inconsistent -> conflict_detected = true       -> accept, flag for review
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";

export interface InvoiceDoc {
  id: string;
  note: string;
  text: string;
}

export const INVOICES: InvoiceDoc[] = (
  JSON.parse(readFileSync(new URL("../fixtures/invoices.json", import.meta.url), "utf-8")) as { invoices: InvoiceDoc[] }
).invoices;

const ISO_4217 = ["USD", "EUR", "GBP", "SGD", "JPY", "AUD", "CAD", "CHF"];

export const SYSTEM =
  "Extract the invoice by calling extract_invoice. Compute calculated_total yourself by adding the " +
  "line-item amounts, copy the printed total into stated_total, and set conflict_detected when they " +
  "differ. If a value is not in the document, use null and say why in the matching *_missing_reason field.";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

export const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_invoice",
  description: "Record one invoice.",
  input_schema: {
    type: "object",
    properties: {
      invoice_number: { type: "string" },
      vendor_name: { type: "string" },
      invoice_date: { type: "string", description: "YYYY-MM-DD" },
      currency: { type: "string", description: "ISO 4217 code" },
      po_number: nullableString,
      po_number_missing_reason: nullableString,
      line_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number" },
            amount: { type: "number" },
          },
          required: ["description", "quantity", "unit_price", "amount"],
        },
      },
      stated_total: { type: "number", description: "Total exactly as printed" },
      calculated_total: { type: "number", description: "Sum of line_items[].amount, computed by you" },
      conflict_detected: { type: "boolean", description: "true when stated_total != calculated_total" },
    },
    required: [
      "invoice_number", "vendor_name", "invoice_date", "currency", "po_number",
      "po_number_missing_reason", "line_items", "stated_total", "calculated_total", "conflict_detected",
    ],
  },
};

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; // rejects 2026-02-30
}

const LineItem = z.strictObject({
  description: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  amount: z.number(),
});

export const InvoiceExtraction = z
  .strictObject({
    invoice_number: z.string(),
    vendor_name: z.string(),
    invoice_date: z.string().superRefine((v, ctx) => {
      if (!isIsoDate(v)) ctx.addIssue({ code: "custom", message: `must be ISO 8601 YYYY-MM-DD, got ${JSON.stringify(v)}` });
    }),
    currency: z.string().superRefine((v, ctx) => {
      if (!ISO_4217.includes(v)) {
        ctx.addIssue({ code: "custom", message: `must be an ISO 4217 code such as USD, EUR or GBP, got ${JSON.stringify(v)}` });
      }
    }),
    po_number: z.string().nullable(),
    po_number_missing_reason: z.string().nullable(),
    line_items: z.array(LineItem).min(1),
    stated_total: z.number(),
    calculated_total: z.number(),
    conflict_detected: z.boolean(),
  })
  .superRefine((inv, ctx) => {
    const items = Math.round(inv.line_items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    if (Math.abs(items - inv.calculated_total) > 0.01) {
      ctx.addIssue({ code: "custom", message: `calculated_total ${inv.calculated_total} != sum of line_items ${items}` });
      return;
    }
    const conflict = Math.abs(inv.calculated_total - inv.stated_total) > 0.01;
    if (conflict !== inv.conflict_detected) {
      ctx.addIssue({ code: "custom", message: `conflict_detected must be ${conflict} for these totals` });
    }
  });
export type InvoiceExtraction = z.infer<typeof InvoiceExtraction>;

export interface Issue {
  field: string;
  message: string;
  kind: "format" | "structural" | "arithmetic" | "missing_required";
}

// Where the source would show the value if it were there. Used to decide whether a retry can help.
const EVIDENCE: Record<string, RegExp> = { po_number: /\bPO-\d+\b/ };

/** Schema + semantic validation, then business completeness (PO needed to pay). */
export function validate(data: Record<string, unknown> | null): { inv: InvoiceExtraction | null; issues: Issue[] } {
  if (data === null) return { inv: null, issues: [{ field: "(response)", message: "no extract_invoice call in the response", kind: "structural" }] };
  const parsed = InvoiceExtraction.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((err): Issue => {
      const field = err.path.length ? err.path.join(".") : err.code === "custom" ? "(totals)" : "(object)";
      const kind = field === "invoice_date" || field === "currency" ? "format" : field === "(totals)" ? "arithmetic" : "structural";
      return { field, message: err.message, kind };
    });
    return { inv: null, issues };
  }
  if (parsed.data.po_number === null) {
    return {
      inv: parsed.data,
      issues: [{ field: "po_number", message: "required for payment: accounts payable matches on PO number", kind: "missing_required" }],
    };
  }
  return { inv: parsed.data, issues: [] };
}

/** Retry fixes OUTPUT mistakes. It cannot conjure information the source does not contain. */
export function isRetryable(issue: Issue, document: string): boolean {
  if (issue.kind !== "missing_required") return true;
  const pattern = EVIDENCE[issue.field];
  return pattern !== undefined && pattern.test(document); // the value IS in the document: worth a retry
}

export function feedbackText(issues: Issue[]): string {
  const lines = issues.map((i) => `- ${i.field}: ${i.message}`).join("\n");
  return (
    "The extraction failed validation:\n" +
    `${lines}\n` +
    "Re-read the document and call extract_invoice again. Fix only these fields; keep the rest unchanged."
  );
}
