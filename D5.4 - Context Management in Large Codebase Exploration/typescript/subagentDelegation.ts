/**
 * D5.4 - Delegate verbose exploration to subagents; inject phase summaries into the next phase.
 *
 * Part 1. The main agent needs two answers: "find all test files" and "trace refund flow dependencies".
 *   A  inline     the main agent explores itself; every file it reads stays in ITS context
 *   B  delegated  the main agent spawns two subagents in one turn (each starts with a fresh
 *                 context, so the task prompt carries everything it needs) and keeps only
 *                 their concise summaries for high-level coordination
 *
 * Part 2. Phase 2 ("propose missing tests for the refund window") is spawned twice: with the
 * phase-1 key findings injected into its initial prompt, and without them.
 *
 * Run:  npx tsx subagentDelegation.ts          (offline)
 *       npx tsx subagentDelegation.ts --live   (real API; repo tools stay local and read-only)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { ANALYST_PROMPT, EXPLORER_PROMPT, EXPLORER_TOOLS, exchanges, execute, runAgent, scriptedModel, type Executor } from "./explorer.ts";

const COORDINATOR_PROMPT =
  "You coordinate codebase exploration. Delegate verbose discovery to subagents with spawn_subagent " +
  "(several in one turn when they are independent) and keep only their summaries. Subagents start with " +
  "a fresh context: put everything they need in the task.";
const SPAWN_TOOL: Anthropic.Tool = {
  name: "spawn_subagent",
  description: "Start a read-only explorer subagent (glob, grep, read_file) with a fresh context. Returns its concise summary.",
  input_schema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
};
const MAIN_QUESTION = "Map the refund path: which test files exist and how does a refund flow through the code?";
const INLINE_TASK = "Find all test files, then trace refund flow dependencies starting from post_refund. Report both.";
const SUBTASKS = [
  "Find all test files under tests/ and summarize what each one covers.",
  "Trace refund flow dependencies starting from the HTTP handler post_refund.",
];
const PHASE2_TASK = "Propose missing test cases for the refund-window rule.";

function scriptedCoordinator(params: lab.CreateParams): Anthropic.Message {
  const seen = exchanges(params);
  if (!seen.length) {
    // two independent investigations -> two spawns in ONE turn (parallel)
    return lab.message([lab.text("Delegating both investigations."), ...SUBTASKS.map((task) => lab.toolUse("spawn_subagent", { task }))]);
  }
  return lab.message([lab.text(seen.map((e) => e.content).join("\n\n"))]);
}

function responder(params: lab.CreateParams): Anthropic.Message {
  return lab.systemText(params).startsWith(COORDINATOR_PROMPT) ? scriptedCoordinator(params) : scriptedModel(params);
}

interface SpawnLog {
  task: string;
  calls: number;
  toolChars: number;
  summaryChars: number;
}

function spawnExecutor(client: lab.MessagesClient, log: SpawnLog[]): Executor {
  return async (name, args) => {
    if (name !== "spawn_subagent") return execute(name, args);
    const sub = await runAgent(client, EXPLORER_PROMPT, args.task, EXPLORER_TOOLS); // fresh context, no parent history
    log.push({ task: args.task, calls: sub.calls.length, toolChars: sub.toolChars, summaryChars: sub.answer.length });
    return [sub.answer, false];
  };
}

lab.banner("D5.4  Subagent delegation and phase summaries");
const client = lab.getClient(responder);

lab.section("Part 1A - inline: the main agent explores everything itself");
const inline = await runAgent(client, EXPLORER_PROMPT, INLINE_TASK, EXPLORER_TOOLS);
console.log(`main agent: ${inline.calls.length} tool calls, ${inline.toolChars.toLocaleString("en-US")} chars of tool output in the MAIN context`);

lab.section("Part 1B - delegated: two subagents, summaries only");
const log: SpawnLog[] = [];
const delegated = await runAgent(client, COORDINATOR_PROMPT, MAIN_QUESTION, [SPAWN_TOOL], spawnExecutor(client, log));
for (const entry of log) {
  console.log(
    `  subagent: ${entry.task}\n    ${entry.calls} tool calls, ${entry.toolChars.toLocaleString("en-US")} chars stayed in the subagent; ` +
      `returned ${entry.summaryChars.toLocaleString("en-US")} chars`,
  );
}
console.log(`main agent: ${JSON.stringify(delegated.calls)}, ${delegated.toolChars.toLocaleString("en-US")} chars in the MAIN context`);
const saved = 100 - Math.floor((delegated.toolChars * 100) / inline.toolChars);
console.log(`main-context saving: ${saved}%`);

lab.section("Part 2 - phase 2 with and without the phase-1 summary");
const keyFindings = delegated.answer.split("\n").filter((line) => line.startsWith("- "));
const phase1Summary = "Phase 1 key findings:\n" + keyFindings.join("\n");
console.log(`phase-1 summary injected into the phase-2 prompt: ${phase1Summary.length.toLocaleString("en-US")} chars`);
const withSummary = await runAgent(client, ANALYST_PROMPT, `${phase1Summary}\n\nTask: ${PHASE2_TASK}`, EXPLORER_TOOLS);
const without = await runAgent(client, ANALYST_PROMPT, `Task: ${PHASE2_TASK}`, EXPLORER_TOOLS);
console.log(`  with summary:    tools ${JSON.stringify(withSummary.calls)}`);
console.log(`  without summary: tools ${JSON.stringify(without.calls)}`);
console.log("phase-2 answer:\n  " + withSummary.answer.replaceAll("\n", "\n  "));

lab.section("Checks");
const firstTurn = delegated.messages[1].content;
const spawnsInFirstTurn = typeof firstTurn === "string" ? 0 : firstTurn.filter((b) => b.type === "tool_use").length;
lab.check(
  JSON.stringify(delegated.calls) === '["spawn_subagent","spawn_subagent"]' && spawnsInFirstTurn === 2,
  "the coordinator spawned both subagents in ONE assistant turn (parallel)",
);
if (lab.isLive()) {
  console.log("  live run: remaining checks depend on the model's choices; skipped");
} else {
  for (const marker of ["ReturnEligibilityGate", "tests/policies/test_eligibility_gate.py"]) {
    lab.check(inline.answer.includes(marker) && delegated.answer.includes(marker), `both approaches surfaced ${marker}`);
  }
  lab.check(saved >= 60, "delegation kept the verbose file contents out of the main context (>= 60% smaller)");
  lab.check(JSON.stringify(withSummary.calls) === '["read_file","read_file"]', "phase 2 with the injected summary went straight to the two relevant files");
  lab.check(
    without.calls.includes("grep") && without.calls.includes("glob") && without.calls.length >= 5,
    "phase 2 without it had to rediscover the code with grep and glob first",
  );
  lab.check(withSummary.answer === without.answer, "same proposals either way; the summary only removed rework");
}
