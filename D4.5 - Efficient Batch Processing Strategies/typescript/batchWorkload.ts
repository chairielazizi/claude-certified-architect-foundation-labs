/**
 * The workload for D4.5: 24 supplier contracts for an overnight renewal report.
 *
 * Holds the document generator, the two prompt versions (v1 before refinement, v2 after), the
 * offline extraction model, request building with custom_id, output validation, and the chunk /
 * merge helpers used when a document is too long for one request.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as lab from "../../shared/typescript/labkit.ts";
import type { BatchRequest } from "./fakeBatchService.ts";

const SUPPLIERS = [
  "Northwind Office Supply", "Bluepeak Consulting", "Harbor Catering", "Atlas Hardware",
  "Meridian Group", "Orbit Cloud", "Kestrel Print Works", "Granite Facilities",
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const OVERSIZED = "doc-017";

export const PROMPT_V1 =
  "Extract the supplier, renewal date, whether the contract auto-renews, and the notice period in days. Reply in JSON.";
export const PROMPT_V2 =
  'Extract fields from the contract. Respond with JSON only: {"supplier": string|null, ' +
  '"renewal_date": "YYYY-MM-DD"|null, "auto_renews": true|false|null, "notice_days": integer|null}. ' +
  "The document may be one part of a longer contract: use null for anything not in this part. Never guess.";

export interface Truth {
  supplier: string;
  renewal_date: string;
  auto_renews: boolean;
  notice_days: number;
}

export interface ContractDoc {
  id: string;
  text: string;
  truth: Truth;
}

export function makeDocuments(n = 24): ContractDoc[] {
  const docs: ContractDoc[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `doc-${String(i).padStart(3, "0")}`;
    const month = (i % 12) + 1;
    const day = ((i * 7) % 28) + 1;
    const iso = `2027-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const printed = i % 3 === 0 ? `${day} ${MONTHS[month - 1]} 2027` : iso; // every 3rd doc spells the date out
    const clauses = id === OVERSIZED ? 160 : 4 + (i % 5);
    const supplier = SUPPLIERS[(i - 1) % SUPPLIERS.length];
    const notice = 30 + (i % 4) * 15;
    const lines = [
      `DOCUMENT ${id}`,
      `Supplier: ${supplier}`,
      `Renewal date: ${printed}`,
      `Auto-renewal: ${i % 2 === 0 ? "yes" : "no"}`,
      ...Array.from(
        { length: clauses },
        (_, k) =>
          `Clause ${k + 1}. The supplier shall provide the services described in schedule ${k + 1} in line with the ` +
          "agreed service levels, security requirements, data-protection terms and monthly reporting obligations.",
      ),
      `Notice period: ${notice} days`, // at the END: in the last part once chunked
    ];
    docs.push({ id, text: lines.join("\n"), truth: { supplier, renewal_date: iso, auto_renews: i % 2 === 0, notice_days: notice } });
  }
  return docs;
}

// zod objects do not coerce: "yes" is not a boolean, "45" is not a number - format drift fails.
export const ContractFields = z.strictObject({
  supplier: z.string().nullable(),
  renewal_date: z
    .string()
    .nullable()
    .superRefine((v, ctx) => {
      if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) ctx.addIssue({ code: "custom", message: `must be YYYY-MM-DD, got ${JSON.stringify(v)}` });
    }),
  auto_renews: z.boolean().nullable(),
  notice_days: z.number().int().nullable(),
});
export type ContractFields = z.infer<typeof ContractFields>;
const FIELDS = ["supplier", "renewal_date", "auto_renews", "notice_days"] as const;

export function parseOutput(text: string): [ContractFields | null, string] {
  const start = text.indexOf("{"); // tolerate prose around the JSON
  const end = text.lastIndexOf("}");
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [null, "not JSON"];
  }
  const parsed = ContractFields.safeParse(data);
  if (parsed.success) return [parsed.data, "ok"];
  const err = parsed.error.issues[0];
  return [null, `${err.path.join(".")}: ${err.message}`];
}

export function sameFields(a: ContractFields, b: Truth): boolean {
  return FIELDS.every((f) => a[f] === b[f]);
}

/** One batch entry: { custom_id, params } where params is a normal messages.create body. */
export function buildRequest(customId: string, text: string, system: string = PROMPT_V2): BatchRequest {
  return {
    custom_id: customId,
    params: {
      model: lab.MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: `<document>\n${text}\n</document>` }],
    },
  };
}

/** Split on line boundaries into parts under maxTokens; ids like doc-017#p1. */
export function chunkDocument(docId: string, text: string, maxTokens: number): [string, string][] {
  const parts: string[][] = [[]];
  let size = 0;
  for (const line of text.split("\n")) {
    if (size + Math.floor(line.length / 4) > maxTokens && parts[parts.length - 1].length) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1].push(line);
    size += Math.floor(line.length / 4) + 1;
  }
  return parts.map((lines, n): [string, string] => [`${docId}#p${n + 1}`, lines.join("\n")]);
}

/** First non-null value per field, in part order (header facts in p1, notice in the last part). */
export function mergeParts(parts: ContractFields[]): ContractFields {
  const first = (f: (typeof FIELDS)[number]): unknown => {
    const hit = parts.find((p) => p[f] !== null);
    return hit ? hit[f] : null;
  };
  return ContractFields.parse({
    supplier: first("supplier"),
    renewal_date: first("renewal_date"),
    auto_renews: first("auto_renews"),
    notice_days: first("notice_days"),
  });
}

// ---------------------------------------------------------------------------
// Offline model
// ---------------------------------------------------------------------------

function toIso(raw: string): string {
  const m = raw.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  return m ? `${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}` : raw;
}

/** Follows the prompt it is given: v1 copies dates as printed, v2 normalizes and uses null. */
export function extractionModel(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  const text = (lab.lastUserText(params).match(/<document>\n([\s\S]*)\n<\/document>/) ?? ["", ""])[1];
  const field = (label: string): string | null => {
    const m = text.match(new RegExp(`^${label}: (.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const supplier = field("Supplier");
  const rawDate = field("Renewal date");
  const auto = field("Auto-renewal");
  const notice = text.match(/Notice period: (\d+) days/);
  const tools = (params.tools ?? []) as unknown as { name: string }[];
  if (tools.length) {
    // Asked to look something up first: the turn ends with a tool call. In a batch there is no one
    // to run it - the request is simply finished with stop_reason "tool_use".
    return lab.message([lab.toolUse(tools[0].name, { supplier })]);
  }
  const data = {
    supplier,
    renewal_date: rawDate ? (system.includes("YYYY-MM-DD") ? toIso(rawDate) : rawDate) : null,
    auto_renews: auto ? auto === "yes" : null,
    notice_days: notice ? Number(notice[1]) : null,
  };
  return lab.message([lab.text(JSON.stringify(data))]);
}
