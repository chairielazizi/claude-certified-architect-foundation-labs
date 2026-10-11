/**
 * D1.3 - Parallel subagent spawning: several Agent calls in ONE coordinator response.
 *
 * Simulated at the Messages API level so the timing is visible. The coordinator has one tool,
 * "Agent" (same input shape as the Agent SDK's spawning tool), and the executor runs every Agent
 * tool_use block of a turn as a separate subagent call with a fresh, one-message context.
 *
 *   A  parallel prompt, concurrent executor: one turn with 4 Agent calls -> Promise.all
 *   B  the same turn executed one call after another (the executor matters too)
 *   C  anti-pattern: the coordinator emits one Agent call per turn, across separate turns
 *
 * Every model call carries 300 ms of simulated latency (lab.getClient(responder, 300)).
 *
 * Run:  npx tsx parallelSpawning.ts          (offline, simulated latency)
 *       npx tsx parallelSpawning.ts --live   (real API; timings then depend on the model)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { AGENT_SPECS, COORDINATOR_PROMPT, PARALLEL_SENTENCE, TOPIC, isDelegation } from "./agentDefinitions.ts";
import { FINDINGS, scriptedSynthesizer, structuredHandoff, type ResearchFinding } from "./contextPassing.ts";

const LATENCY_MS = 300;
const SAFETY_MAX_TURNS = 12;

/** The spawning tool, as a Messages API tool definition. */
const AGENT_TOOL: Anthropic.Tool = {
  name: "Agent",
  description:
    "Spawn a subagent with a fresh, empty context. subagent_type selects its definition; prompt must " +
    "contain everything the subagent needs. Several Agent calls in one response run in parallel.",
  input_schema: {
    type: "object",
    properties: {
      subagent_type: { type: "string", enum: Object.keys(AGENT_SPECS) },
      description: { type: "string", description: "3-5 word label for the task" },
      prompt: { type: "string", description: "The complete task for the subagent" },
    },
    required: ["subagent_type", "description", "prompt"],
  },
};

// The anti-pattern prompt: same goals, but it tells the coordinator to serialise delegation.
const SERIAL_SENTENCE = "Delegate one task at a time and wait for each result before starting the next.";
const ONE_AT_A_TIME_PROMPT = COORDINATOR_PROMPT.replace(PARALLEL_SENTENCE, SERIAL_SENTENCE);

// A type alias (not an interface) so it stays assignable to Record<string, unknown>.
type AgentInput = { subagent_type: string; description: string; prompt: string };

/** Four independent research tasks: none needs another's output, so they can all run at once. */
const RESEARCH_TASKS: AgentInput[] = [
  { subagent_type: "web-researcher", description: "Music licensing news",
    prompt: "Find 2026 news about record labels licensing catalogues to AI music companies." },
  { subagent_type: "doc-analyst", description: "Music rights report",
    prompt: "From ./docs/music_rights_review_2026.md extract findings on AI-training licence income in music." },
  { subagent_type: "web-researcher", description: "VFX adoption news",
    prompt: "Find 2026 news or surveys on how many VFX studios use generative AI." },
  { subagent_type: "doc-analyst", description: "VFX workforce study",
    prompt: "From ./docs/screen_vfx_workforce_study_2026.md extract findings on generative AI adoption in VFX studios." },
];
const SYNTHESIS_LABEL = "Synthesize briefing";

// ---------------------------------------------------------------------------
// Offline stand-ins: one responder plays the coordinator and every subagent
// ---------------------------------------------------------------------------

function scriptedSubagent(name: string, params: lab.CreateParams): Anthropic.Message {
  if (name === "synthesizer") return scriptedSynthesizer(params);
  const task = lab.lastUserText(params).toLowerCase();
  const subject = task.includes("music") ? "music" : "vfx";
  const hits = FINDINGS.filter((f) => f.agent === name && f.content.claim.toLowerCase().includes(subject));
  return lab.message([lab.text(JSON.stringify(hits))]);
}

/** Decides from the conversation: what has been spawned, what came back, what the prompt asks. */
function scriptedCoordinator(params: lab.CreateParams): Anthropic.Message {
  const done = new Set<string>();
  const results: string[] = [];
  for (const m of params.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (m.role === "assistant" && b.type === "tool_use") done.add((b.input as AgentInput).description);
      if (m.role === "user" && b.type === "tool_result") results.push(lab.toolResultText(b));
    }
  }
  const pending = RESEARCH_TASKS.filter((t) => !done.has(t.description));
  if (pending.length) {
    // A coordinator told to fan out emits every independent task in this one response.
    const batch = lab.systemText(params).includes(PARALLEL_SENTENCE) ? pending : pending.slice(0, 1);
    return lab.message([
      lab.text(`Spawning ${batch.length} research subagent(s).`),
      ...batch.map((t) => lab.toolUse("Agent", t)),
    ]);
  }
  if (!done.has(SYNTHESIS_LABEL)) {
    // Synthesis depends on all research, so it waits; it gets the COMPLETE findings as JSON.
    const findings = results.flatMap((r) => JSON.parse(r) as ResearchFinding[]);
    return lab.message([
      lab.toolUse("Agent", { subagent_type: "synthesizer", description: SYNTHESIS_LABEL, prompt: structuredHandoff(TOPIC, findings) }),
    ]);
  }
  return lab.message([lab.text(results[results.length - 1])]);
}

function scriptedWorld(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  for (const [name, spec] of Object.entries(AGENT_SPECS)) {
    if (system === spec.prompt) return scriptedSubagent(name, params);
  }
  return scriptedCoordinator(params);
}

// ---------------------------------------------------------------------------
// Executors and the coordinator loop
// ---------------------------------------------------------------------------

/** One subagent = one call with its own system prompt and a fresh one-message context. */
async function runSubagent(client: lab.MessagesClient, block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  const input = block.input as AgentInput;
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system: AGENT_SPECS[input.subagent_type].prompt,
    messages: [{ role: "user", content: input.prompt }],
  });
  return { type: "tool_result", tool_use_id: block.id, content: lab.textOf(response) };
}

type Executor = (client: lab.MessagesClient, blocks: Anthropic.ToolUseBlock[]) => Promise<Anthropic.ToolResultBlockParam[]>;

const runConcurrently: Executor = (client, blocks) => Promise.all(blocks.map((b) => runSubagent(client, b)));

const runOneByOne: Executor = async (client, blocks) => {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const b of blocks) results.push(await runSubagent(client, b));
  return results;
};

interface Run {
  answer: string;
  callsPerTurn: number[];
  seconds: number;
  messages: Anthropic.MessageParam[];
}

async function runCoordinator(client: lab.MessagesClient, system: string, executor: Executor): Promise<Run> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: TOPIC }];
  const callsPerTurn: number[] = [];
  const start = Date.now();
  for (let turn = 0; turn < SAFETY_MAX_TURNS; turn++) {
    const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system, tools: [AGENT_TOOL], messages });
    messages.push({ role: "assistant", content: response.content });
    const spawns = lab.toolUses(response).filter((b) => isDelegation(b.name));
    callsPerTurn.push(spawns.length);
    if (response.stop_reason !== "tool_use") {
      // end_turn (D1.1 covers the other stop reasons)
      return { answer: lab.textOf(response), callsPerTurn, seconds: (Date.now() - start) / 1000, messages };
    }
    // Every result of this turn goes back in ONE user message, matched by tool_use_id.
    messages.push({ role: "user", content: await executor(client, spawns) });
  }
  throw new Error(`Coordinator did not finish in ${SAFETY_MAX_TURNS} turns`);
}

function blocksOf(message: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
  return typeof message.content === "string" ? [] : message.content;
}

lab.banner("D1.3  Parallel subagent spawning (multiple Agent calls in one response)");

const scenarios: [string, string, string, Executor][] = [
  ["A", "A - all Agent calls in one response, run concurrently", COORDINATOR_PROMPT, runConcurrently],
  ["B", "B - the same response, run one call at a time", COORDINATOR_PROMPT, runOneByOne],
  ["C", "C - anti-pattern: one Agent call per coordinator turn", ONE_AT_A_TIME_PROMPT, runConcurrently],
];
const runs: Record<string, Run> = {};
const clients: Record<string, lab.MessagesClient> = {};
for (const [key, title, system, executor] of scenarios) {
  lab.section(title);
  clients[key] = lab.getClient(scriptedWorld, LATENCY_MS);
  runs[key] = await runCoordinator(clients[key], system, executor);
  console.log(`Agent calls per coordinator turn: ${JSON.stringify(runs[key].callsPerTurn)}`);
  console.log(`coordinator turns: ${runs[key].callsPerTurn.length}   wall-clock: ${runs[key].seconds.toFixed(2)}s`);
}

lab.section("Result");
console.log("  " + runs.A.answer.replaceAll("\n", "\n  "));
const [a, b, c] = [runs.A.seconds, runs.B.seconds, runs.C.seconds];
console.log(`wall-clock  A parallel ${a.toFixed(2)}s | B same turn, sequential ${b.toFixed(2)}s | C one per turn ${c.toFixed(2)}s`);

const first = runs.A.callsPerTurn[0];
if (first) {
  const spawnIds = blocksOf(runs.A.messages[1]).flatMap((blk) => (blk.type === "tool_use" ? [blk.id] : [])).sort();
  const answerIds = blocksOf(runs.A.messages[2]).flatMap((blk) => (blk.type === "tool_result" ? [blk.tool_use_id] : [])).sort();
  lab.check(JSON.stringify(spawnIds) === JSON.stringify(answerIds),
    `the ${first} results of the fan-out turn went back in ONE user message, matched by tool_use_id`);
}
if (!lab.isLive()) {
  lab.check(runs.A.callsPerTurn[0] === 4, "one coordinator response carried 4 Agent tool_use blocks");
  lab.check(Math.max(...runs.C.callsPerTurn) === 1 && runs.C.callsPerTurn.length === 6,
    "the anti-pattern needed 6 coordinator turns (one Agent call each) instead of 3");
  lab.check(a < b * 0.8, `concurrent execution of that response beat sequential execution (${a.toFixed(2)}s vs ${b.toFixed(2)}s)`);
  lab.check(a < c * 0.6, `parallel spawning beat one Agent call per turn (${a.toFixed(2)}s vs ${c.toFixed(2)}s)`);
  lab.check(runs.A.answer === runs.B.answer && runs.B.answer === runs.C.answer, "same briefing every time: only latency changed");
  const calls = clients.A instanceof lab.ScriptedClient ? clients.A.calls : [];
  const subagentCalls = calls.filter((p) => lab.systemText(p) !== COORDINATOR_PROMPT);
  lab.check(subagentCalls.every((p) => p.messages.length === 1), "every subagent started from a fresh one-message context");
  const synth = subagentCalls.find((p) => lab.systemText(p) === AGENT_SPECS.synthesizer.prompt);
  const synthPrompt = synth ? lab.lastUserText(synth) : "";
  lab.check(FINDINGS.every((f) => synthPrompt.includes(f.finding_id)),
    "the synthesizer's prompt carried the complete findings from all four research subagents");
}
