/**
 * D2.3 - tool_choice: "auto", "any", forced {type: "tool"} and the modern alternative.
 *
 *   1. Semantics on a conversational message:
 *        auto -> the model MAY answer in text     any  -> it MUST call some tool
 *        tool -> it MUST call the named tool      none -> it must not call tools
 *   2. Forced first step: {type: "tool", name: "extract_metadata"} on turn 1, then follow-up
 *      turns with "auto" for the enrichment tools. Compared with auto-only, where the model is
 *      free to start with an enrichment tool and skip the prerequisite.
 *   3. Modern alternative on lab.MODEL (which rejects forced choice with HTTP 400):
 *      auto + strict: true + an instruction naming the tool + VERIFY a tool_use came back,
 *      re-prompting if it did not.
 *
 * Offline, a scripted model honors the tool_choice semantics exactly as the API defines them
 * and otherwise decides from the conversation. Live, forced ("any"/"tool") requests use
 * lab.FORCED_TOOL_CHOICE_MODEL because claude-opus-5-5 returns 400 for them.
 *
 * Run:  npx tsx toolChoiceDemo.ts          (offline)
 *       npx tsx toolChoiceDemo.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

const SYSTEM_PROMPT = "You are the document-analysis agent in a research system. Work with documents by their id using the tools.";

const EXTRACT_METADATA = {
  name: "extract_metadata",
  description:
    "Read a stored document by id and return {document_id, title, authors[], year, doi}. " +
    "Run this before any enrichment tool: lookup_citations needs the DOI and " +
    "lookup_author_affiliations needs the author list it returns.",
  input_schema: {
    type: "object" as const,
    properties: { document_id: { type: "string", description: "Stored document id, for example doc-17" } },
    required: ["document_id"],
    additionalProperties: false,
  },
};
const TOOLS = [
  EXTRACT_METADATA,
  {
    name: "lookup_citations",
    description: "Return {doi, citation_count} for a DOI such as 10.5555/abc.123. Needs a real DOI (from extract_metadata).",
    input_schema: { type: "object" as const, properties: { doi: { type: "string", description: "DOI, 10.xxxx/..." } }, required: ["doi"] },
  },
  {
    name: "lookup_author_affiliations",
    description: "Return {affiliations: {author: institution}} for a list of author names (from extract_metadata).",
    input_schema: {
      type: "object" as const,
      properties: { authors: { type: "array", items: { type: "string" }, description: "Author names" } },
      required: ["authors"],
    },
  },
] as unknown as Anthropic.Tool[];
// Modern alternative: strict: true guarantees schema-valid input for extract_metadata.
const STRICT_TOOLS = [{ ...EXTRACT_METADATA, strict: true }, ...TOOLS.slice(1)] as unknown as Anthropic.Tool[];

interface Doc {
  document_id: string;
  title: string;
  authors: string[];
  year: number;
  doi: string;
}
const DOCS: Record<string, Doc> = {
  "doc-17": {
    document_id: "doc-17",
    title: "Generative Models in Film Post-Production",
    authors: ["R. Okafor", "L. Chen"],
    year: 2025,
    doi: "10.5555/film.2025.017",
  },
};
const DOI = /^10\.\d{4,9}\/\S+$/;

function execute(name: string, args: Record<string, unknown>): [string, boolean] {
  if (name === "extract_metadata") {
    const doc = DOCS[String(args.document_id ?? "")];
    return doc ? [JSON.stringify(doc), false] : [JSON.stringify({ errorCategory: "validation", message: "unknown document_id" }), true];
  }
  if (name === "lookup_citations") {
    const doi = String(args.doi ?? "");
    if (!DOI.test(doi)) return [JSON.stringify({ errorCategory: "validation", message: `'${doi}' is not a DOI; get it from extract_metadata` }), true];
    return [JSON.stringify({ doi, citation_count: 42 }), false];
  }
  if (name === "lookup_author_affiliations") {
    const known: Record<string, string> = { "R. Okafor": "Lagos Institute of Media Arts", "L. Chen": "Vancouver Film School" };
    const authors = Array.isArray(args.authors) ? args.authors.map(String) : [];
    return [JSON.stringify({ affiliations: Object.fromEntries(authors.map((a) => [a, known[a] ?? "unknown"])) }), false];
  }
  return [JSON.stringify({ error: `unknown tool ${name}` }), true];
}

/** Params for one turn. Forced choices go to a model that accepts them (see SDK notes). */
function buildRequest(
  toolChoice: Anthropic.ToolChoice,
  messages: Anthropic.MessageParam[],
  opts: { system?: string; tools?: Anthropic.Tool[]; model?: string } = {},
): lab.CreateParams {
  const forced = toolChoice.type === "any" || toolChoice.type === "tool";
  return {
    model: opts.model ?? (forced ? lab.FORCED_TOOL_CHOICE_MODEL : lab.MODEL),
    max_tokens: 16000,
    system: opts.system ?? SYSTEM_PROMPT,
    tools: opts.tools ?? TOOLS,
    tool_choice: toolChoice,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Offline model: honors tool_choice, otherwise decides from the conversation
// ---------------------------------------------------------------------------

interface Answered {
  name: string;
  result: Record<string, unknown>;
  isError: boolean;
}

/** Every tool call answered so far, with its parsed result. */
function toolHistory(params: lab.CreateParams): Answered[] {
  const calls = new Map<string, string>();
  const history: Answered[] = [];
  for (const msg of params.messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") calls.set(block.id, block.name);
      else if (block.type === "tool_result" && calls.has(block.tool_use_id)) {
        history.push({
          name: calls.get(block.tool_use_id) ?? "",
          result: JSON.parse(lab.toolResultText(block)) as Record<string, unknown>,
          isError: block.is_error === true,
        });
      }
    }
  }
  return history;
}

function firstRequest(params: lab.CreateParams): string {
  const first = params.messages[0].content;
  return typeof first === "string" ? first : "";
}

/** What the model would do if left to choose (tool_choice auto). */
function wantedAction(params: lab.CreateParams): Anthropic.ContentBlock[] {
  const request = firstRequest(params);
  const lastText = lab.lastUserText(params);
  const history = toolHistory(params);
  const ok: Record<string, Record<string, unknown>> = {};
  for (const h of history) if (!h.isError) ok[h.name] = h.result;
  const failed = new Set(history.filter((h) => h.isError).map((h) => h.name));
  const doc = request.match(/doc-\d+/);
  const docId = doc ? doc[0] : "";

  if (lastText.toLowerCase().includes("call extract_metadata")) return [lab.toolUse("extract_metadata", { document_id: docId })]; // explicit re-prompt
  if (ok.extract_metadata) {
    const meta = ok.extract_metadata as unknown as Doc;
    if (!ok.lookup_citations) {
      return [
        lab.text("Metadata in hand; enriching it."),
        lab.toolUse("lookup_citations", { doi: meta.doi }),
        lab.toolUse("lookup_author_affiliations", { authors: meta.authors }),
      ];
    }
    const affResult: Record<string, unknown> = ok.lookup_author_affiliations ?? {};
    const affiliations = (affResult.affiliations ?? {}) as Record<string, string>;
    return [
      lab.text(
        `'${meta.title}' (${meta.year}, DOI ${meta.doi}) has ${String(ok.lookup_citations.citation_count)} citations. ` +
          `Authors: ${Object.entries(affiliations).map(([a, i]) => `${a} (${i})`).join(", ")}.`,
      ),
    ];
  }
  if (lastText.trimEnd().endsWith("?")) {
    // A direct question tends to get a direct answer under auto, instructions or not.
    return [lab.text("I can read PDF, HTML and plain-text documents. Peer review status isn't something I can confirm from the id alone.")];
  }
  if (doc && /citation|affiliation/i.test(request) && !failed.has("lookup_citations")) {
    // Free to choose, it jumps straight to the tool that matches the request's wording,
    // skipping the prerequisite step (it passes the document id where a DOI belongs).
    return [lab.toolUse("lookup_citations", { doi: docId })];
  }
  if (doc) return [lab.toolUse("extract_metadata", { document_id: docId })];
  return [lab.text("Which document should I look at?")];
}

function semanticModel(params: lab.CreateParams): Anthropic.Message {
  const choice: Anthropic.ToolChoice = params.tool_choice ?? { type: "auto" };
  const blocks = wantedAction(params);
  const uses = blocks.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (choice.type === "none") {
    const texts = blocks.filter((b) => b.type === "text");
    return lab.message(texts.length > 0 ? texts : [lab.text("(answering without tools)")]);
  }
  if (choice.type === "auto") return lab.message(blocks);
  if (choice.type === "any") {
    // Must call SOME tool. Forced turns come back without a text preamble.
    const first = (params.tools ?? [])[0] as unknown as { name: string };
    return lab.message(uses.length > 0 ? uses : [lab.toolUse(first.name, { document_id: "unknown" })]);
  }
  // {type: "tool", name: X}: must call exactly that tool.
  const name = choice.name;
  const match = uses.find((b) => b.name === name);
  const doc = firstRequest(params).match(/doc-\d+/);
  return lab.message([match ?? lab.toolUse(name, { document_id: doc ? doc[0] : "unknown" })]);
}

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

interface Sent {
  model: string;
  tool_choice: Anthropic.ToolChoice;
}

/** First turn uses `firstChoice`; every follow-up turn uses auto. */
async function runLoop(
  client: lab.MessagesClient,
  request: string,
  firstChoice: Anthropic.ToolChoice,
  model?: string,
): Promise<{ order: string[]; sent: Sent[]; answer: string }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: request }];
  let choice = firstChoice;
  const order: string[] = [];
  const sent: Sent[] = [];
  for (let i = 0; i < 8; i++) {
    const params = buildRequest(choice, messages, { model });
    sent.push({ model: params.model, tool_choice: choice });
    const response = await client.messages.create(params);
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return { order, sent, answer: lab.textOf(response) };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of lab.toolUses(response)) {
      const [content, isError] = execute(block.name, block.input as Record<string, unknown>);
      order.push(block.name + (isError ? " (error)" : ""));
      results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
    choice = { type: "auto" }; // forced only where the guarantee is needed: the first step
  }
  throw new Error("loop did not finish");
}

/** Modern alternative to forcing: auto + strict tool + instruction, then VERIFY. */
async function callUntilTool(
  client: lab.MessagesClient,
  toolName: string,
  request: string,
  maxAttempts = 3,
): Promise<{ response: Anthropic.Message; attempts: number; sent: Sent[] }> {
  const system = `${SYSTEM_PROMPT} Always begin by calling ${toolName} for the document, before answering anything else.`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: request }];
  const sent: Sent[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const params = buildRequest({ type: "auto" }, messages, { system, tools: STRICT_TOOLS });
    sent.push({ model: params.model, tool_choice: { type: "auto" } });
    const response = await client.messages.create(params);
    if (lab.toolUses(response).some((b) => b.name === toolName)) return { response, attempts: attempt, sent };
    // No tool call came back: keep the model's turn and ask again, explicitly.
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: `Please call ${toolName} for that document now, as instructed.` });
  }
  throw new Error(`${toolName} was not called after ${maxAttempts} attempts`);
}

function describe(response: Anthropic.Message): string {
  const kinds = response.content
    .filter((b) => b.type === "text" || b.type === "tool_use")
    .map((b) => (b.type === "tool_use" ? `tool_use:${b.name}` : b.type));
  return `stop_reason=${response.stop_reason} content=${JSON.stringify(kinds)}`;
}

lab.banner("D2.3  tool_choice: auto, any, forced tool, and the modern alternative");
const client = lab.getClient(semanticModel);

lab.section("1. Same conversational message, four tool_choice settings");
const chat = "Thanks! Quick question - which file formats can you read?";
console.log(`user: ${chat}`);
const seen: Record<string, { model: string; response: Anthropic.Message }> = {};
const choices: [string, Anthropic.ToolChoice][] = [
  ["auto", { type: "auto" }],
  ["any", { type: "any" }],
  ["tool", { type: "tool", name: "extract_metadata" }],
  ["none", { type: "none" }],
];
for (const [label, choice] of choices) {
  const params = buildRequest(choice, [{ role: "user", content: chat }]);
  const response = await client.messages.create(params);
  seen[label] = { model: params.model, response };
  console.log(`  ${JSON.stringify(choice).padEnd(48)} model=${params.model.padEnd(16)} ${describe(response)}`);
}

lab.section("2a. auto on every turn");
const task = "Add citation counts and author affiliations for document doc-17.";
console.log(`user: ${task}`);
const autoRun = await runLoop(client, task, { type: "auto" });
console.log(`  tool order: ${JSON.stringify(autoRun.order)}`);

lab.section("2b. forced extract_metadata first, then auto");
const forcedRun = await runLoop(client, task, { type: "tool", name: "extract_metadata" }, lab.FORCED_TOOL_CHOICE_MODEL);
console.log(`  tool order: ${JSON.stringify(forcedRun.order)}`);
console.log(`  tool_choice per turn: ${JSON.stringify(forcedRun.sent.map((s) => s.tool_choice.type))}`);
console.log(`  answer: ${forcedRun.answer}`);

lab.section(`3. Modern alternative on ${lab.MODEL}: auto + strict + instruction + verify`);
const question = "Here's doc-17. Before anything else - is it peer-reviewed?";
console.log(`user: ${question}`);
const strictRun = await callUntilTool(client, "extract_metadata", question);
console.log(`  extract_metadata came back on attempt ${strictRun.attempts}: ${describe(strictRun.response)}`);
console.log(`  requests: ${JSON.stringify(strictRun.sent)}`);

lab.section("Checks");
lab.check(
  seen.any.model === lab.FORCED_TOOL_CHOICE_MODEL && seen.tool.model === lab.FORCED_TOOL_CHOICE_MODEL,
  `forced requests (any/tool) use ${lab.FORCED_TOOL_CHOICE_MODEL}, not ${lab.MODEL}`,
);
lab.check(lab.toolUses(seen.any.response).length > 0, "tool_choice any: the model called a tool instead of replying in text");
lab.check(
  JSON.stringify(lab.toolUses(seen.tool.response).map((b) => b.name)) === '["extract_metadata"]',
  "forced tool_choice: exactly the named tool was called",
);
lab.check(lab.toolUses(seen.none.response).length === 0, "tool_choice none: no tool call");
lab.check(forcedRun.order[0] === "extract_metadata", "forced first step guaranteed: extract_metadata ran before enrichment");
lab.check(forcedRun.sent.slice(1).every((s) => s.tool_choice.type === "auto"), "follow-up turns went back to auto");
lab.check(
  strictRun.sent.every((s) => s.model === lab.MODEL && s.tool_choice.type === "auto"),
  `modern alternative stays on ${lab.MODEL} with tool_choice auto`,
);
lab.check(EXTRACT_METADATA.input_schema.additionalProperties === false, "strict tool: additionalProperties false + required fields");
if (!lab.isLive()) {
  lab.check(lab.toolUses(seen.auto.response).length === 0, "tool_choice auto: the model chose to answer in text");
  lab.check(autoRun.order[0].startsWith("lookup_citations (error)"), "auto-only: model skipped extract_metadata and wasted a call on a bad DOI");
  lab.check(
    forcedRun.answer.includes("42 citations") && !forcedRun.order.join(" ").includes("(error)"),
    "forced pipeline enriched with the real DOI and authors, no errors",
  );
  lab.check(strictRun.attempts === 2, "verify step caught a text-only reply and the re-prompt produced the tool call");
}
