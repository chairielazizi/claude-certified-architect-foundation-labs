/**
 * D5.4 - A scratchpad file persists key findings across context boundaries.
 *
 * Two sessions explore the same repo and answer two questions. Between the questions the
 * context is compacted (what /compact or automatic compaction does in a long session), so
 * only a short summary of window 1 survives into window 2.
 *
 *   A  no scratchpad   window 2 sees only the compacted gist -> the answer drifts to "typical patterns"
 *   B  scratchpad      window 1 writes exact findings to .lab-runtime/scratchpad.md;
 *                      window 2 reads it first -> the answer cites the specific class, file and constant
 *
 * Run:  npx tsx scratchpadMemory.ts          (offline)
 *       npx tsx scratchpadMemory.ts --live   (real API; the repo tools stay local and read-only)
 */
import { existsSync, readFileSync } from "node:fs";
import * as lab from "../../shared/typescript/labkit.ts";
import {
  COMPACT_PROMPT,
  EXPLORER_PROMPT,
  EXPLORER_TOOLS,
  SCRATCHPAD,
  SCRATCHPAD_RULES,
  SCRATCHPAD_TOOLS,
  exchanges,
  resetRuntime,
  runAgent,
  scriptedModel,
  type AgentRun,
} from "./explorer.ts";

const Q1 = "Trace refund flow dependencies starting from the HTTP handler post_refund. Which classes are involved?";
const Q2 = "Which class enforces the refund window, in which file, and how many days is it?";

function transcriptOf(run: AgentRun): string {
  const lines = [`user: ${Q1}`];
  for (const e of exchanges({ messages: run.messages })) lines.push(`tool ${e.name}(${JSON.stringify(e.args)}) ->\n${e.content}`);
  lines.push(`assistant: ${run.answer}`);
  return lines.join("\n");
}

async function compact(client: lab.MessagesClient, transcript: string): Promise<string> {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system: COMPACT_PROMPT,
    messages: [{ role: "user", content: `Transcript:\n${transcript}` }],
  });
  return lab.textOf(response);
}

async function session(withScratchpad: boolean) {
  const client = lab.getClient(scriptedModel);
  const system = EXPLORER_PROMPT + (withScratchpad ? SCRATCHPAD_RULES : "");
  const tools = withScratchpad ? [...EXPLORER_TOOLS, ...SCRATCHPAD_TOOLS] : EXPLORER_TOOLS;
  const window1 = await runAgent(client, system, Q1, tools);
  const summary = await compact(client, transcriptOf(window1)); // the context boundary
  const prompt2 = `Context summary from earlier in this session (after compaction):\n${summary}\n\nQuestion: ${Q2}`;
  const window2 = await runAgent(client, system, prompt2, tools);
  return { window1, summary, window2 };
}

lab.banner("D5.4  Scratchpad files counteract context degradation");
resetRuntime();
const runs: Record<string, Awaited<ReturnType<typeof session>>> = {};
for (const [key, title, flag] of [
  ["A", "A - no scratchpad", false],
  ["B", "B - scratchpad at .lab-runtime/scratchpad.md", true],
] as const) {
  lab.section(title);
  const run = await session(flag);
  const { window1: w1, window2: w2 } = run;
  console.log(`window 1: ${w1.calls.length} tool calls, ${w1.toolChars.toLocaleString("en-US")} chars of tool output in context`);
  console.log("  " + w1.answer.split("\n").slice(0, 4).join("\n  ") + "\n  ...");
  console.log(`compacted summary: ${run.summary}`);
  console.log(`window 2: tools ${JSON.stringify(w2.calls)}, ${w2.toolChars.toLocaleString("en-US")} chars of tool output`);
  console.log(`  Q: ${Q2}\n  A: ${w2.answer}`);
  runs[key] = run;
}

lab.section("Scratchpad file");
const pad = existsSync(SCRATCHPAD) ? readFileSync(SCRATCHPAD, "utf-8") : "";
console.log(`.lab-runtime/scratchpad.md (${pad.length.toLocaleString("en-US")} chars):`);
console.log(pad.split("\n").slice(0, 5).join("\n") + "\n...");

lab.section("Checks");
if (lab.isLive()) {
  console.log("  live run: answers above come from the real model; offline checks skipped");
} else {
  const a = runs.A;
  const b = runs.B;
  lab.check(a.window1.answer.includes("ReturnEligibilityGate"), "window 1 found the specific class in both sessions");
  lab.check(!a.summary.includes("ReturnEligibilityGate"), "compaction kept the gist but dropped the exact class names");
  lab.check(
    a.window2.answer.includes("Typically") && !a.window2.answer.includes("ReturnEligibilityGate"),
    "A: after the boundary the answer drifted to a 'typical pattern' (and the wrong window length)",
  );
  lab.check(
    ["ReturnEligibilityGate", "src/policies/eligibility_gate.py", "RETURN_WINDOW_DAYS = 45"].every((s) => pad.includes(s)),
    "B: the scratchpad holds exact class names, file paths and constants",
  );
  const answer = b.window2.answer;
  lab.check(
    b.window2.calls[0] === "read_scratchpad" && answer.includes("ReturnEligibilityGate") && answer.includes("45"),
    "B: the new context read the scratchpad first and answered with the specific class and value",
  );
  lab.check(b.window2.toolChars * 3 < b.window1.toolChars, "B: re-reading the scratchpad cost a fraction of re-exploring the files");
}
