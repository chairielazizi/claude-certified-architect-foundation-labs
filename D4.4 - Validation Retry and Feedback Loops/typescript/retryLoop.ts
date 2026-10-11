/**
 * D4.4 - Validation-retry with error feedback, and knowing when NOT to retry.
 *
 *   extract -> validate (zod: formats, totals, conflict flag) -> issues?
 *       none                               -> accept (flag for review if conflict_detected)
 *       retryable (format/structure/math)  -> follow-up request = original document
 *                                             + the failed extraction + the specific errors
 *       not retryable (info not in source) -> do not retry: keep null + reason, route on
 *
 * Run:  npx tsx retryLoop.ts          (offline, scripted model)
 *       npx tsx retryLoop.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { EXTRACT_TOOL, INVOICES, SYSTEM, feedbackText, isRetryable, validate, type InvoiceDoc, type Issue } from "./invoiceValidation.ts";
import { scriptedExtractor } from "./scriptedExtractor.ts";

const MAX_RETRIES = 2;

interface Outcome {
  docId: string;
  status: "accepted" | "needs_review" | "accepted_with_gaps" | "failed";
  calls: number;
  data: Record<string, unknown> | null;
  gaps: Record<string, string>;
  log: Issue[][];
}

async function extractWithRetry(client: lab.MessagesClient, invoice: InvoiceDoc, smart = true): Promise<Outcome> {
  const document = invoice.text;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `<document>\n${document}\n</document>` }];
  const log: Issue[][] = [];
  let data: Record<string, unknown> | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const response = await client.messages.create({ model: lab.MODEL, max_tokens: 4000, system: SYSTEM, tools: [EXTRACT_TOOL], messages });
    const block = lab.toolUses(response)[0];
    data = block ? { ...(block.input as Record<string, unknown>) } : null;
    const { inv, issues } = validate(data);
    log.push(issues);
    if (!issues.length) {
      // Valid. A conflict in the SOURCE is not an extraction error: keep both totals, flag it.
      return { docId: invoice.id, status: inv && inv.conflict_detected ? "needs_review" : "accepted", calls: attempt, data, gaps: {}, log };
    }
    const retryable = smart ? issues.filter((i) => isRetryable(i, document)) : issues;
    if (!retryable.length) {
      const gaps: Record<string, string> = {};
      for (const i of issues) gaps[i.field] = String(data?.[`${i.field}_missing_reason`] ?? i.message);
      return { docId: invoice.id, status: "accepted_with_gaps", calls: attempt, data, gaps, log };
    }
    if (attempt > MAX_RETRIES) break;
    // Follow-up request: the original document stays as messages[0], the failed extraction is the
    // assistant tool_use, and the specific validation errors go back as an error result.
    messages.push({ role: "assistant", content: response.content });
    messages.push(
      block
        ? { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: feedbackText(retryable), is_error: true }] }
        : { role: "user", content: feedbackText(retryable) },
    );
  }
  return { docId: invoice.id, status: "failed", calls: MAX_RETRIES + 1, data, gaps: {}, log };
}

lab.banner("D4.4  Validation, retry with error feedback, retry limits");

lab.section("1. Extract -> validate -> retry only what a retry can fix");
const outcomes: Record<string, Outcome> = {};
const clients: Record<string, lab.MessagesClient> = {};
for (const invoice of INVOICES) {
  const client = (clients[invoice.id] = lab.getClient(scriptedExtractor));
  const outcome = (outcomes[invoice.id] = await extractWithRetry(client, invoice));
  console.log(`  ${invoice.id} (${invoice.note})`);
  outcome.log.forEach((issues, n) => {
    const listed = issues
      .map((i) => `${i.field} [${i.kind}${isRetryable(i, invoice.text) ? "" : ", NOT retryable"}]: ${i.message}`)
      .join("; ");
    console.log(`     attempt ${n + 1}: ${listed || "valid"}`);
  });
  let extra = "";
  if (outcome.data && outcome.data.conflict_detected) {
    extra = `  stated_total=${outcome.data.stated_total} calculated_total=${outcome.data.calculated_total}`;
  }
  if (Object.keys(outcome.gaps).length) extra = `  null + reason: ${JSON.stringify(outcome.gaps)}`;
  console.log(`     -> ${outcome.status} after ${outcome.calls} call(s)${extra}`);
}

let failedInput: Record<string, unknown> = {};
let firstMessage = "";
let feedback: Anthropic.ToolResultBlockParam | null = null;
if (!lab.isLive()) {
  lab.section("2. What the retry request for INV-A contained");
  const retryRequest = (clients["INV-A"] as lab.ScriptedClient).calls[1].messages;
  firstMessage = String(retryRequest[0].content);
  failedInput = (retryRequest[1].content as unknown as Anthropic.ToolUseBlock[])[0].input as Record<string, unknown>;
  feedback = (retryRequest[2].content as unknown as Anthropic.ToolResultBlockParam[])[0];
  console.log(`  messages[0] user     : original document (${firstMessage.length} chars)`);
  console.log(
    `  messages[1] assistant: failed extraction -> invoice_date=${JSON.stringify(failedInput.invoice_date)}, currency=${JSON.stringify(failedInput.currency)}`,
  );
  console.log(`  messages[2] user     : tool_result is_error=${feedback.is_error} ->\n      ${lab.toolResultText(feedback).replace(/\n/g, "\n      ")}`);
}

lab.section("3. Naive loop (retry every error) vs smart loop");
let naiveCalls = 0;
let smartCalls = 0;
for (const invoice of INVOICES) {
  const naive = await extractWithRetry(lab.getClient(scriptedExtractor), invoice, false);
  const smart = outcomes[invoice.id];
  naiveCalls += naive.calls;
  smartCalls += smart.calls;
  console.log(`  ${invoice.id}: naive ${naive.calls} call(s) -> ${naive.status.padEnd(18)} smart ${smart.calls} call(s) -> ${smart.status}`);
}
console.log(`  wasted retries avoided: ${naiveCalls - smartCalls}`);

if (!lab.isLive()) {
  const a = outcomes["INV-A"];
  const b = outcomes["INV-B"];
  const c = outcomes["INV-C"];
  const d = outcomes["INV-D"];
  lab.check(a.status === "accepted" && a.calls === 2, "INV-A: format errors fixed on the retry");
  lab.check(
    failedInput.invoice_date === "14/03/2026" &&
      firstMessage.includes("Kestrel Print Works") &&
      feedback !== null &&
      lab.toolResultText(feedback).includes("invoice_date: must be ISO 8601") &&
      feedback.is_error === true,
    "the retry request carried the original document, the failed extraction and the specific errors",
  );
  lab.check(
    b.calls === 1 && b.status === "accepted_with_gaps" && b.data !== null && b.data.po_number === null,
    "INV-B: PO number not in the source -> no retry, po_number left null",
  );
  lab.check((b.gaps.po_number ?? "").includes("attached purchase order"), "INV-B: the reason it is null travels with the record");
  lab.check(
    c.status === "needs_review" && c.calls === 1 && c.data !== null && c.data.calculated_total === 1150 && c.data.stated_total === 1200,
    "INV-C: stated vs calculated totals disagree in the SOURCE -> conflict_detected, routed to review, not retried",
  );
  lab.check(d.status === "accepted" && d.calls === 1, "INV-D: clean invoice accepted on the first call");
  lab.check(naiveCalls - smartCalls === MAX_RETRIES, `classifying errors avoided ${MAX_RETRIES} pointless retries on INV-B`);
}
