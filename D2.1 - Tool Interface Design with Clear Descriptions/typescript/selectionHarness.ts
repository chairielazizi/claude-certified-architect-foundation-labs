/**
 * D2.1 - Tool-selection reliability harness: same requests, two toolsets, measured accuracy.
 *
 * Each request is sent with tool_choice {type: "auto"} and we record which tool the model
 * picks first. Three runs:
 *   A  BAD_TOOLS  + reviewed system prompt   (minimal / overlapping descriptions)
 *   B  GOOD_TOOLS + reviewed system prompt   (expanded, differentiated descriptions)
 *   C  GOOD_TOOLS + keyword-trap prompt      (good descriptions overridden by prompt wording)
 *
 * Offline, a "description-sensitive" stand-in model chooses: it scores each tool by how
 * much of the request its name + description + parameter docs support (boundary sentences
 * such as "Does not ... use X instead" count AGAINST the tool), and when the top candidates
 * are too close to call it guesses the first-listed one. Claude is not a keyword matcher,
 * but this reproduces the mechanism the exam describes: the description is the main
 * evidence for selection, so thin evidence -> unreliable picks.
 *
 * Run:  npx tsx selectionHarness.ts          (offline stand-in model)
 *       npx tsx selectionHarness.ts --live   (real Claude API, tool_choice auto)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { keywordRules, lintSystemPrompt, scoreTools, stem, tokens } from "./toolLint.ts";
import {
  BAD_TOOLS,
  GOOD_TOOLS,
  KEYWORD_TRAP_SYSTEM_PROMPT,
  RENAMES,
  REQUESTS,
  REVIEWED_SYSTEM_PROMPT,
  type ToolDef,
} from "./toolsets.ts";

// The best tool must lead the runner-up by at least this much evidence; otherwise the
// stand-in "can't tell them apart" and takes the first-listed candidate.
const MARGIN = 2;

/** Offline stand-in for Claude choosing a tool under tool_choice auto. */
function descriptionSensitiveModel(params: lab.CreateParams): Anthropic.Message {
  const tools = (params.tools ?? []) as unknown as ToolDef[];
  const names = tools.map((t) => t.name);
  const request = lab.lastUserText(params);

  const call = (name: string): Anthropic.Message => {
    const tool = tools.find((t) => t.name === name);
    const schema = tool ? tool.input_schema : { properties: {}, required: [] as string[] };
    const required = schema.required ?? [];
    const fields = required.length > 0 ? required : Object.keys(schema.properties).slice(0, 1);
    const input: Record<string, unknown> = {};
    for (const f of fields) input[f] = request;
    return lab.message([lab.toolUse(name, input)]);
  };

  // 1. Prompt instructions are strong signals. A keyword-triggered rule fires on the
  //    keyword alone - exactly the unintended association the prompt linter flags.
  for (const [keyword, tool] of keywordRules(lab.systemText(params))) {
    if (tokens(request).has(stem(keyword)) && names.includes(tool)) return call(tool);
  }

  // 2. Otherwise choose on description evidence. No tool has any -> answer in text
  //    (tool_choice auto allows that). Several within MARGIN of the best -> the
  //    descriptions do not separate them, so the pick is a guess: first-listed.
  const scored = scoreTools(tools, request);
  const best = Math.max(...scored.map(([, s]) => s));
  if (best <= 0) return lab.message([lab.text("I'm not sure which tool handles that - could you clarify?")]);
  const nearTied = scored.filter(([, s]) => s > 0 && s > best - MARGIN).map(([n]) => n);
  return call(nearTied[0]);
}

async function pickTool(client: lab.MessagesClient, tools: ToolDef[], system: string, request: string): Promise<string | null> {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 4000, // one tool choice per request; thinking still needs some room
    system,
    tools: tools as unknown as Anthropic.Tool[],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: request }],
  });
  const uses = lab.toolUses(response);
  return uses.length > 0 ? uses[0].name : null; // null = answered in text instead
}

async function evaluate(label: string, tools: ToolDef[], system: string): Promise<[number, Record<string, string | null>]> {
  lab.section(label);
  const client = lab.getClient(descriptionSensitiveModel);
  const names = new Set(tools.map((t) => t.name));
  const picks: Record<string, string | null> = {};
  let correct = 0;
  for (const [request, expectedGood] of REQUESTS) {
    // Map the expected answer onto this toolset (split tools collapse to analyze_document).
    const expected = names.has(expectedGood) ? expectedGood : RENAMES[expectedGood];
    const chosen = await pickTool(client, tools, system, request);
    picks[request] = chosen;
    const ok = chosen === expected;
    if (ok) correct++;
    console.log(`  ${ok ? "ok  " : "MISS"} ${request.slice(0, 58).padEnd(58)} -> ${chosen ?? "(text answer)"}  (expected ${expected})`);
  }
  const accuracy = correct / REQUESTS.length;
  console.log(`  accuracy: ${correct}/${REQUESTS.length} = ${Math.round(accuracy * 100)}%`);
  return [accuracy, picks];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

lab.banner("D2.1  Tool selection reliability: minimal vs differentiated descriptions");

lab.section("Why sample question 2 misroutes: evidence per tool for 'check my order #12345'");
const q2 = REQUESTS[0][0];
console.log(`  request tokens: ${JSON.stringify([...tokens(q2)].sort())}`);
console.log(`  BAD : ${JSON.stringify(scoreTools(BAD_TOOLS, q2))}`);
console.log(`  GOOD: ${JSON.stringify(scoreTools(GOOD_TOOLS, q2))}`);
console.log(`  BAD : both tools take an untyped 'Identifier'; lookup_order leads by 1 (< margin ${MARGIN})`);
console.log("        -> the descriptions do not separate them -> guess: first-listed get_customer");
console.log("  GOOD: '#12345' matches lookup_order's documented input format, and get_customer's");
console.log("        boundary sentence ('send it to lookup_order instead') counts against it");

const [accBad, picksBad] = await evaluate("A - BAD_TOOLS, reviewed prompt", BAD_TOOLS, REVIEWED_SYSTEM_PROMPT);
const [accGood, picksGood] = await evaluate("B - GOOD_TOOLS, reviewed prompt", GOOD_TOOLS, REVIEWED_SYSTEM_PROMPT);
const [accTrap, picksTrap] = await evaluate("C - GOOD_TOOLS, keyword-trap prompt", GOOD_TOOLS, KEYWORD_TRAP_SYSTEM_PROMPT);

lab.section("Prompt review");
const namesGood = GOOD_TOOLS.map((t) => t.name);
for (const f of lintSystemPrompt(KEYWORD_TRAP_SYSTEM_PROMPT, namesGood)) console.log(`  - ${f}`);

lab.section("Checks");
lab.check(lintSystemPrompt(KEYWORD_TRAP_SYSTEM_PROMPT, namesGood).length > 0, "prompt linter flags the keyword-trigger instructions");
lab.check(lintSystemPrompt(REVIEWED_SYSTEM_PROMPT, namesGood).length === 0, "reviewed prompt (rule stated by intent) has no keyword triggers");
if (!lab.isLive()) {
  lab.check(accGood > accBad, `expanded descriptions route better (${pct(accGood)} vs ${pct(accBad)})`);
  lab.check(accGood === 1, "every ambiguous request reaches the intended tool with GOOD_TOOLS");
  lab.check(picksBad[q2] === "get_customer", "sample Q2 reproduced: minimal descriptions send 'check my order' to get_customer");
  lab.check(picksGood[q2] === "lookup_order", "same request routes to lookup_order once descriptions are expanded");
  lab.check(
    picksTrap[q2] === "get_customer" && accTrap < accGood,
    "keyword-sensitive prompt wording overrides good descriptions (unintended association)",
  );
} else {
  console.log(`  live accuracy: bad=${pct(accBad)} good=${pct(accGood)} keyword-trap=${pct(accTrap)} (varies run to run)`);
}
