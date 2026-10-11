/**
 * D4.3 - tool_choice: "auto" vs "any" vs forced {type: "tool", name: ...}.
 *
 *   auto   -> the model MAY reply in text: no structured data is guaranteed
 *   any    -> the model MUST call a tool but picks which: right for an unknown document type
 *             with one extraction schema per type
 *   forced -> the model MUST call this tool: guarantees extract_metadata runs first, then the
 *             code routes to the enrichment tool in a follow-up turn
 *
 * Live note: claude-opus-5-5 rejects "any"/forced with HTTP 400, so those calls use
 * lab.FORCED_TOOL_CHOICE_MODEL (claude-opus-5). See modernStructuredOutput.ts for the
 * lab.MODEL alternatives.
 *
 * Run:  npx tsx toolChoiceModes.ts          (offline, scripted model)
 *       npx tsx toolChoiceModes.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import {
  EXTRACTION_TOOLS,
  METADATA_TOOL,
  SYSTEM_WITH_RULES,
  asTools,
  doc,
  documentMessage,
  firstToolUse,
  type ToolDef,
} from "./extractionTools.ts";
import { scriptedExtractor } from "./scriptedExtractor.ts";

const ROUTE: Record<string, string> = { invoice: "extract_invoice", receipt: "extract_receipt", contract: "extract_contract" };

const client = lab.getClient(scriptedExtractor);

function call(model: string, system: string, tools: ToolDef[], toolChoice: Anthropic.ToolChoice, messages: Anthropic.MessageParam[]) {
  return client.messages.create({ model, max_tokens: 4000, system, tools: asTools(tools), tool_choice: toolChoice, messages });
}

lab.banner("D4.3  tool_choice auto / any / forced");

lab.section('A. tool_choice {"type": "auto"}: the model may just talk');
const autoResponse = await call(
  lab.MODEL,
  "You help the finance team with incoming business documents.",
  EXTRACTION_TOOLS,
  { type: "auto" },
  [{ role: "user", content: documentMessage(doc("inv-001")) }],
);
console.log(`  stop_reason=${autoResponse.stop_reason}  text=${JSON.stringify(lab.textOf(autoResponse))}`);
if (!lab.isLive()) {
  lab.check(firstToolUse(autoResponse) === null, "auto: a text reply is a valid answer, so no structured data came back");
}

lab.section('B. tool_choice {"type": "any"}: unknown document type, three schemas');
const picked: Record<string, string | null> = {};
for (const docId of ["inv-001", "rcpt-001", "ctr-001"]) {
  const response = await call(
    lab.FORCED_TOOL_CHOICE_MODEL, // "any" is a 400 on claude-opus-5-5
    SYSTEM_WITH_RULES,
    EXTRACTION_TOOLS,
    { type: "any" },
    [{ role: "user", content: documentMessage(doc(docId)) }],
  );
  const block = firstToolUse(response);
  picked[docId] = block ? block.name : null;
  const data = block ? block.input : {}; // structured data = the tool_use block's input
  console.log(`  ${docId.padEnd(9)} -> ${String(picked[docId]).padEnd(17)} ${JSON.stringify(data).slice(0, 90)}...`);
}
lab.check(Object.values(picked).every((n) => n !== null), "any: every response carried a tool_use block");
lab.check(
  picked["inv-001"] === "extract_invoice" && picked["rcpt-001"] === "extract_receipt" && picked["ctr-001"] === "extract_contract",
  "any: the model chose the schema that matches each document",
);

lab.section('C. forced {"type": "tool", "name": "extract_metadata"}, then enrichment');
const tools = [METADATA_TOOL, ...EXTRACTION_TOOLS];
const messages: Anthropic.MessageParam[] = [{ role: "user", content: documentMessage(doc("ctr-001")) }];
const first = await call(lab.FORCED_TOOL_CHOICE_MODEL, SYSTEM_WITH_RULES, tools, { type: "tool", name: "extract_metadata" }, messages);
const metaBlock = firstToolUse(first);
if (!metaBlock) throw new Error("forced tool_choice must return a tool_use block");
const metadata = metaBlock.input as { doc_type: string };
lab.show("  turn 1 extract_metadata", metadata);

// Follow-up turn: return the tool_result, then force the enrichment tool the CODE picked from
// the metadata. The order is guaranteed by the request, not hoped for in a prompt.
const nextTool = ROUTE[metadata.doc_type] ?? null;
messages.push(
  { role: "assistant", content: first.content },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: metaBlock.id, content: "metadata recorded" },
      { type: "text", text: "Now record the detailed fields." },
    ],
  },
);
const second = await call(
  lab.FORCED_TOOL_CHOICE_MODEL,
  SYSTEM_WITH_RULES,
  tools,
  { type: "tool", name: nextTool ?? "extract_metadata" },
  messages,
);
const enrichBlock = firstToolUse(second);
if (!enrichBlock) throw new Error("forced tool_choice must return a tool_use block");
lab.show(`  turn 2 ${enrichBlock.name}`, enrichBlock.input);

lab.check(metaBlock.name === "extract_metadata", "forced: metadata extraction ran first although extract_contract was available");
lab.check(nextTool === "extract_contract" && enrichBlock.name === nextTool, "the follow-up turn ran the enrichment tool routed from the metadata");
if (!lab.isLive()) {
  lab.check((enrichBlock.input as { term_months: number }).term_months === 24, "enrichment output is read straight from tool_use.input");
}
