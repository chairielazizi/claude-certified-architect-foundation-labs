/**
 * D4.3 - Guaranteed structure on claude-opus-5-5, which rejects forced tool_choice.
 *
 *   1. Structured outputs: output_config.format = json_schema -> the text block IS valid JSON
 *   2. strict: true tool + tool_choice auto + a prompt that names the tool
 *      -> verify a tool_use came back; if not, re-prompt (auto never guarantees a call)
 *
 * Both run on lab.MODEL. Forced "any"/"tool" (toolChoiceModes.ts) needs
 * lab.FORCED_TOOL_CHOICE_MODEL instead.
 *
 * Run:  npx tsx modernStructuredOutput.ts          (offline, scripted model)
 *       npx tsx modernStructuredOutput.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import {
  FORMAT_RULES,
  INVOICE_TOOL,
  Invoice,
  SYSTEM_WITH_RULES,
  asTools,
  doc,
  documentMessage,
  firstToolUse,
} from "./extractionTools.ts";
import { scriptedExtractor } from "./scriptedExtractor.ts";

const MAX_REPROMPTS = 1;

async function extractStructuredOutput(client: lab.MessagesClient, docId: string): Promise<Invoice> {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 4000,
    system: `You extract data from business documents.\n\n${FORMAT_RULES}`,
    output_config: { format: { type: "json_schema", schema: INVOICE_TOOL.input_schema as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: documentMessage(doc(docId)) }],
  });
  return Invoice.parse(JSON.parse(lab.textOf(response)));
}

/** auto + strict tool + named in the prompt, then VERIFY and re-prompt if needed. */
async function extractStrictTool(
  client: lab.MessagesClient,
  docId: string,
): Promise<{ inv: Invoice; attempts: number; history: Anthropic.MessageParam[] }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: documentMessage(doc(docId)) }];
  for (let attempt = 1; attempt <= MAX_REPROMPTS + 1; attempt++) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 4000,
      system: SYSTEM_WITH_RULES + "\nAlways respond by calling extract_invoice.",
      tools: asTools([INVOICE_TOOL]), // strict: true -> arguments always match the schema
      tool_choice: { type: "auto" },
      messages,
    });
    const block = firstToolUse(response);
    if (block) return { inv: Invoice.parse(block.input), attempts: attempt, history: messages };
    console.log(`    attempt ${attempt}: text instead of a tool call -> ${JSON.stringify(lab.textOf(response).slice(0, 70))}`);
    messages.push(
      { role: "assistant", content: response.content },
      { role: "user", content: "Call extract_invoice now with the fields from the document. Do not answer in text." },
    );
  }
  throw new Error(`${docId}: no tool call after ${MAX_REPROMPTS} re-prompt(s); route to manual review`);
}

lab.banner("D4.3  Structured outputs and strict tools on lab.MODEL");
const client = lab.getClient(scriptedExtractor);

lab.section('1. output_config.format {"type": "json_schema"}');
const structured: Record<string, Invoice> = {};
for (const docId of ["inv-001", "inv-002"]) {
  const inv = (structured[docId] = await extractStructuredOutput(client, docId));
  console.log(
    `  ${docId}: vendor=${JSON.stringify(inv.vendor_name)} date=${JSON.stringify(inv.invoice_date)} ` +
      `po=${JSON.stringify(inv.po_number)} total=${inv.total}`,
  );
}
lab.check(Object.keys(structured).length === 2, "the text block parsed with JSON.parse + zod for every document, no tool_choice involved");
if (!lab.isLive()) lab.check(structured["inv-002"].po_number === null, "the same nullable schema works as an output_config format");

lab.section("2. strict tool + auto + verify / re-prompt");
const attempts: Record<string, number> = {};
const history: Record<string, Anthropic.MessageParam[]> = {};
for (const docId of ["inv-001", "inv-006"]) {
  const result = await extractStrictTool(client, docId);
  attempts[docId] = result.attempts;
  history[docId] = result.history;
  console.log(`  ${docId}: tool_use on attempt ${result.attempts} -> vendor=${JSON.stringify(result.inv.vendor_name)} total=${result.inv.total}`);
}

if (!lab.isLive()) {
  lab.check(attempts["inv-001"] === 1, "inv-001: the prompt named the tool and the model called it");
  lab.check(attempts["inv-006"] === 2, "inv-006: under auto the model answered the vendor's question; the verify step caught it");
  const h = history["inv-006"];
  const reprompt = h[h.length - 1];
  lab.check(
    reprompt.role === "user" &&
      typeof reprompt.content === "string" &&
      reprompt.content.includes("extract_invoice") &&
      h[h.length - 2].role === "assistant",
    "the re-prompt kept the text turn in history and named the tool explicitly",
  );
}
