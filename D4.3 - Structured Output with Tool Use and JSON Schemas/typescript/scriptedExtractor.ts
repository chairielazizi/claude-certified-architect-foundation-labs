/**
 * Offline stand-in for Claude doing extraction (D4.3).
 *
 * It reads the document with simple parsers, and decides HOW to answer the way the API contract
 * says the real model must:
 *   tool_choice {type: "tool", name: X} -> calls X, nothing else
 *   tool_choice {type: "any"}           -> calls one of the tools; picks the one that fits
 *   tool_choice {type: "auto"} (default)-> may answer in text instead: when nobody asked for a tool,
 *                                          or when the document asks a question and the latest
 *                                          turn does not name a tool
 *   output_config.format json_schema    -> the answer IS the JSON text
 *   no tools, "return JSON"             -> hand-written JSON in prose + fences (syntax risk)
 *
 * What it extracts also depends on the request: format rules in the system prompt turn on ISO
 * dates / currency codes; the schema decides between null and an invented value, and which
 * category buckets exist.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { INVOICE_TOOL, type JsonSchema, type ObjectSchema } from "./extractionTools.ts";

type Data = Record<string, unknown>;
type Parser = (text: string, schema: ObjectSchema, rules: boolean) => Data;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const CATEGORY_KEYWORDS: [string, string[]][] = [
  ["office_supplies", ["paper", "toner", "stationery"]],
  ["software", ["license", "subscription"]],
  ["hardware", ["laptop", "monitor", "dock"]],
  ["professional_services", ["workshop", "consulting", "audit"]],
  ["travel", ["flight", "hotel", "taxi"]],
];
const OTHER_HINTS: Record<string, string> = { catering: "event catering" };

export function toIso(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let d: number;
  let mo: number;
  let y: number;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // day/month/year per the rules
  if (m) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = s.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/))) {
    [d, mo, y] = [Number(m[2]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[3])];
  } else if ((m = s.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/))) {
    [d, mo, y] = [Number(m[1]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[3])];
  } else {
    return s;
  }
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function field(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`^${escaped}: (.+)$`, "m"));
  return m ? m[1].trim() : null;
}

const money = (value: string) => Number(value.replace(/,/g, ""));

function isNullable(prop: JsonSchema): boolean {
  const options = (prop.anyOf ?? []) as JsonSchema[];
  return options.some((o) => o.type === "null");
}

function categorize(text: string, categoryEnum: string[]): [string, string | null] {
  const lower = text.toLowerCase();
  for (const [category, words] of CATEGORY_KEYWORDS) {
    if (words.some((w) => lower.includes(w))) return [category, null];
  }
  for (const [hint, detail] of Object.entries(OTHER_HINTS)) {
    // Without an "other" bucket the model must force it into a wrong one.
    if (lower.includes(hint)) return categoryEnum.includes("other") ? ["other", detail] : ["travel", null];
  }
  // Not enough information to choose: "unclear" if allowed, otherwise a guess dressed as fact.
  return categoryEnum.includes("unclear") ? ["unclear", null] : ["professional_services", null];
}

export function parseInvoice(text: string, schema: ObjectSchema, rules: boolean): Data {
  const props = schema.properties;
  const totalM = (field(text, "Total due") ?? "").match(/^(\$|[A-Z]{3})\s?([\d,]+\.\d{2})$/);
  const [symbol, total] = totalM ? [totalM[1], money(totalM[2])] : ["", 0];
  const rawDate = field(text, "Invoice date");
  const [category, detail] = categorize(text, props.category.enum as string[]);
  const out: Data = {
    vendor_name: field(text, "Vendor") ?? "",
    // A literal reader puts whatever "reference" it finds into invoice_number.
    invoice_number: field(text, "Invoice #") ?? field(text, "Ref"),
    invoice_date: rawDate ? (rules ? toIso(rawDate) : rawDate) : null,
    po_number: field(text, "PO"),
    currency: rules ? (symbol === "$" ? "USD" : symbol) : symbol,
    category,
    category_detail: detail,
    line_items: [...text.matchAll(/^- (\d+(?:\.\d+)?) x (.+?) @ ([\d,]+\.\d{2}) = ([\d,]+\.\d{2})$/gm)].map((m) => ({
      description: m[2].trim(),
      quantity: Number(m[1]),
      unit_price: money(m[3]),
      amount: money(m[4]),
    })),
    total,
  };
  // A field the document lacks: null if the schema allows it, otherwise invent something
  // plausible to satisfy "required" - the fabrication the exam warns about.
  const fabricated: Data = { invoice_date: "2026-03-01", po_number: out.invoice_number };
  for (const [key, invented] of Object.entries(fabricated)) {
    if (out[key] === null && !isNullable(props[key])) out[key] = invented;
  }
  return out;
}

function parseReceipt(text: string, _schema: ObjectSchema, rules: boolean): Data {
  const rawDate = text.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
  const total = text.match(/^TOTAL (\d+\.\d{2})$/m);
  return {
    merchant: text.split("\n")[0].trim(),
    date: rawDate ? (rules ? toIso(rawDate[1]) : rawDate[1]) : null,
    currency: null, // the receipt prints no currency: null, not a guess
    items: [...text.matchAll(/^(\d+) (.+?) (\d+\.\d{2})$/gm)].map((m) => ({ description: m[2], amount: Number(m[3]) })),
    total: total ? Number(total[1]) : 0,
    payment_method: /VISA|MASTERCARD|AMEX/.test(text) ? "card" : text.includes("CASH") ? "cash" : "unclear",
  };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseContract(text: string, _schema: ObjectSchema, rules: boolean): Data {
  const parties = text.match(/between (.+?) \("(\w+)"\) and (.+?) \("(\w+)"\)/);
  const rawDate = field(text, "Effective date");
  const term = text.match(/^Term: (\d+) months$/m);
  return {
    title: titleCase(text.split("\n")[0].trim()),
    parties: parties
      ? [
          { name: parties[1], role: parties[2] },
          { name: parties[3], role: parties[4] },
        ]
      : [],
    effective_date: rawDate ? (rules ? toIso(rawDate) : rawDate) : null,
    term_months: term ? Number(term[1]) : null,
    governing_law: field(text, "Governing law"),
  };
}

export function detectType(text: string): string {
  const first = text.split("\n")[0].toUpperCase();
  if (first.includes("INVOICE")) return "invoice";
  if (first.includes("AGREEMENT") || first.includes("CONTRACT")) return "contract";
  if (/^TOTAL /m.test(text)) return "receipt";
  return "unclear";
}

function parseMetadata(text: string): Data {
  return {
    doc_type: detectType(text),
    language: "en",
    has_signature: text.includes("Signed:"),
    mentions_amounts: /\d+\.\d{2}/.test(text),
  };
}

const PARSERS: Record<string, Parser> = {
  extract_invoice: parseInvoice,
  extract_receipt: parseReceipt,
  extract_contract: parseContract,
  extract_metadata: (text) => parseMetadata(text),
};

/** How JSON-in-text tends to come back when no schema constrains it. */
function proseJson(data: Data): string {
  let body = JSON.stringify(data, null, 2);
  if ((data.line_items as unknown[]).length > 1) body = body.replace("}\n  ],", "},\n  ],"); // hand-written trailing comma
  return `Here is the extracted invoice data:\n\`\`\`json\n${body}\n\`\`\`\nLet me know if you need anything else.`;
}

interface ToolLike {
  name: string;
  input_schema: ObjectSchema;
}

export function scriptedExtractor(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  const tools = (params.tools ?? []) as unknown as ToolLike[];
  const names = tools.map((t) => t.name);
  const choice = (params.tool_choice ?? { type: "auto" }) as { type: string; name?: string };
  const first = params.messages[0].content;
  const firstText = typeof first === "string" ? first : first.map((b) => (b.type === "text" ? b.text : "")).join("");
  const document = (firstText.match(/<document>\n([\s\S]*)\n<\/document>/) ?? ["", ""])[1];
  const latest = lab.lastUserText(params);
  const rules = system.includes("ISO 8601");
  const docType = detectType(document);

  const fmt = (params as unknown as { output_config?: { format?: { schema: ObjectSchema } | null } }).output_config?.format;
  if (fmt) return lab.message([lab.text(JSON.stringify(parseInvoice(document, fmt.schema, rules)))]); // structured outputs

  if (!tools.length) return lab.message([lab.text(proseJson(parseInvoice(document, INVOICE_TOOL.input_schema, rules)))]);

  let name: string;
  if (choice.type === "none") return lab.message([lab.text(`Document type: ${docType}.`)]);
  if (choice.type === "tool" && choice.name) {
    name = choice.name;
  } else if (choice.type === "any") {
    name = names.includes(`extract_${docType}`) ? `extract_${docType}` : names[0];
  } else {
    // auto: the model decides whether a tool call is the right response
    const named = names.find((n) => latest.includes(n));
    const question = /^Note[^:\n]*: .*\?$/m.test(document);
    if (named) name = named;
    else if (!(system + latest).toLowerCase().includes("tool")) {
      return lab.message([lab.text(`Got it - document type: ${docType}. Want me to pull out the details?`)]);
    } else if (question) {
      return lab.message([lab.text("I can't confirm a delivery address from this invoice; please check with the vendor directly.")]);
    } else if (names.includes(`extract_${docType}`)) name = `extract_${docType}`;
    else return lab.message([lab.text(`None of the tools fits a ${docType}.`)]);
  }

  const schema = tools.find((t) => t.name === name)?.input_schema ?? INVOICE_TOOL.input_schema;
  return lab.message([lab.toolUse(name, PARSERS[name](document, schema, rules))]);
}
