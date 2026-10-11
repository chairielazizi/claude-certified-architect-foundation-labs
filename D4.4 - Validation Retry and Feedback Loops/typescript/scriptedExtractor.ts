/**
 * Offline stand-in for Claude in D4.4's extraction loop.
 *
 * First pass: copies values the way they are printed (so "14/03/2026" and "US dollars" fail
 * validation) - a realistic first-pass miss. On a retry it reads the tool_result error list and
 * fixes exactly the fields that were named, nothing else. It cannot fix what the document does not
 * contain: a PO number that lives in "the attached purchase order" stays null however many times
 * you ask.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

const CURRENCY_WORDS: Record<string, string> = { "us dollars": "USD", euros: "EUR", "pounds sterling": "GBP" };

function iso(raw: string): string {
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : raw;
}

const money = (value: string) => Number(value.replace(/,/g, ""));

export function firstPass(text: string): Record<string, unknown> {
  const field = (label: string): string | null => {
    const m = text.match(new RegExp(`^${label}: (.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const items = [...text.matchAll(/^- (\d+) x (.+?) @ ([\d,]+\.\d{2}) = ([\d,]+\.\d{2})$/gm)].map((m) => ({
    description: m[2].trim(),
    quantity: Number(m[1]),
    unit_price: money(m[3]),
    amount: money(m[4]),
  }));
  const calculated = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const stated = money(field("Total") ?? "0");
  const poLine = field("PO number") ?? "";
  const po = poLine.match(/\bPO-\d+\b/);
  return {
    invoice_number: (text.match(/^INVOICE (\S+)/) ?? ["", ""])[1],
    vendor_name: field("Vendor"),
    invoice_date: field("Invoice date"), // copied as printed
    currency: field("Currency"), // copied as printed
    po_number: po ? po[0] : null,
    po_number_missing_reason: po ? null : `The document says '${poLine}', and that document was not provided.`,
    line_items: items,
    stated_total: stated,
    calculated_total: calculated,
    conflict_detected: Math.abs(calculated - stated) > 0.01,
  };
}

export function scriptedExtractor(params: lab.CreateParams): Anthropic.Message {
  const first = params.messages[0].content;
  const firstText = typeof first === "string" ? first : "";
  const document = (firstText.match(/<document>\n([\s\S]*)\n<\/document>/) ?? ["", ""])[1];
  const data = firstPass(document);

  const errors = lab.toolResults(params).filter((r) => r.is_error);
  if (errors.length) {
    // Retry: fix exactly the fields named in the feedback.
    const named = new Set([...lab.toolResultText(errors[errors.length - 1]).matchAll(/^- (\w+):/gm)].map((m) => m[1]));
    if (named.has("invoice_date")) data.invoice_date = iso(String(data.invoice_date));
    if (named.has("currency")) data.currency = CURRENCY_WORDS[String(data.currency).toLowerCase()] ?? data.currency;
    // "po_number" may be named too, but there is nothing in the document to fix it with.
  }
  return lab.message([lab.toolUse("extract_invoice", data)]);
}
