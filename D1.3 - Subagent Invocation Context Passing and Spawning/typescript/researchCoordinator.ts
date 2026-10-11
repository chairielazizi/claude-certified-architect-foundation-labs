/**
 * D1.3 - A research coordinator built with the Claude Agent SDK.
 *
 *   query({ prompt, options: {
 *     systemPrompt: goals + quality criteria,
 *     agents: { "web-researcher": {...}, "doc-analyst": {...}, synthesizer: {...} },
 *     allowedTools: ["Agent", ...] } })          // "Agent" = the spawning tool (exam: "Task")
 *
 * Offline: prints and checks the options, then replays a recorded message stream through the same
 * delegation detector the live run uses. Live: runs the coordinator and prints every delegation.
 *
 * Run:  npx tsx researchCoordinator.ts          (offline)
 *       npx tsx researchCoordinator.ts --live   (needs the Claude Code runtime; costs tokens)
 */
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { COORDINATOR_PROMPT, PROCEDURAL_PROMPT, TOPIC, buildOptions, isDelegation, stepsIn } from "./agentDefinitions.ts";

const WEB_TOOLS = ["WebSearch", "WebFetch"];

/** Human-readable lines for the parts of the stream that show orchestration. */
export function describeMessage(message: SDKMessage): string[] {
  const lines: string[] = [];
  if (message.type === "assistant") {
    // Messages produced INSIDE a subagent carry the id of the Agent call that spawned it.
    const where = message.parent_tool_use_id ? `  [inside subagent of ${message.parent_tool_use_id}]` : "";
    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      if (isDelegation(block.name)) {
        const input = block.input as Record<string, unknown>;
        lines.push(`DELEGATE via '${block.name}' (${block.id}) -> ${String(input.subagent_type)}: ${String(input.description)}`);
      } else {
        lines.push(`tool call ${block.name}${where}`);
      }
    }
  } else if (message.type === "result") {
    const text = message.subtype === "success" ? message.result : "";
    lines.push(`RESULT subtype=${message.subtype} turns=${message.num_turns}: ${text.slice(0, 300)}`);
  }
  return lines;
}

/** A short stream in the shape the SDK yields, for the offline replay. */
function recordedStream(): SDKMessage[] {
  const raw = [
    {
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "offline",
      message: {
        content: [
          { type: "text", text: "I'll research both sub-areas in parallel." },
          { type: "tool_use", id: "toolu_A1", name: "Agent", input: {
            subagent_type: "web-researcher", description: "Music licensing news",
            prompt: "Find 2026 news on AI music licensing deals ..." } },
          // Older Claude Code versions (and the exam) name the same tool "Task".
          { type: "tool_use", id: "toolu_A2", name: "Task", input: {
            subagent_type: "doc-analyst", description: "VFX workforce study",
            prompt: "From ./docs extract findings on generative AI adoption in VFX ..." } },
        ],
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: "toolu_A2",
      session_id: "offline",
      message: { content: [{ type: "tool_use", id: "toolu_B1", name: "Read", input: { file_path: "docs/screen_vfx_workforce_study_2026.md" } }] },
    },
    {
      type: "result",
      subtype: "success",
      num_turns: 6,
      session_id: "offline",
      result: "Briefing: 28% of VFX studios use generative AI [D2: Screen Industries VFX Workforce Study p.31] ...",
    },
  ];
  return raw.map((m) => m as unknown as SDKMessage);
}

async function runLive(options: Options): Promise<string[]> {
  const events: string[] = [];
  for await (const message of query({ prompt: TOPIC, options })) {
    for (const line of describeMessage(message)) {
      console.log(`  ${line}`);
      events.push(line);
    }
  }
  return events;
}

lab.banner("D1.3  Coordinator with AgentDefinitions (Claude Agent SDK)");
const options = buildOptions();
const allowed = options.allowedTools ?? [];
const agents = options.agents ?? {};

lab.section("Coordinator options");
console.log(`allowedTools:    ${JSON.stringify(allowed)}`);
console.log(`disallowedTools: ${JSON.stringify(options.disallowedTools ?? [])}`);
console.log(`model: ${options.model}   cwd: fixtures/   maxTurns: ${options.maxTurns}`);
console.log("systemPrompt (goals + quality criteria, no procedure):");
console.log("  " + COORDINATOR_PROMPT.replaceAll("\n", "\n  "));

lab.section("Subagent definitions");
for (const [name, agent] of Object.entries(agents)) {
  console.log(`${name}: tools=${JSON.stringify(agent.tools)} model=${agent.model}`);
  console.log(`  description: ${agent.description}`);
  console.log(`  prompt:      ${agent.prompt.slice(0, 100)}...`);
}

const toolsOf = (name: string): string[] => agents[name]?.tools ?? [];
lab.check(allowed.includes("Agent"), "allowedTools includes 'Agent' (the exam's 'Task'), so the coordinator can spawn subagents");
lab.check(
  Object.values(agents).every((a) => Boolean(a.description && a.prompt && a.tools && a.tools.length && a.model === "inherit")),
  "every AgentDefinition has a description, its own prompt, a tool list and model='inherit'",
);
lab.check(
  !toolsOf("synthesizer").some((t) => WEB_TOOLS.includes(t)) && !toolsOf("doc-analyst").some((t) => WEB_TOOLS.includes(t)),
  "least privilege: only web-researcher can reach the web",
);
lab.check(COORDINATOR_PROMPT.includes("Quality criteria") && stepsIn(COORDINATOR_PROMPT).length === 0,
  "coordinator prompt states goals and quality criteria, not step-by-step procedure");
lab.check(stepsIn(PROCEDURAL_PROMPT).length === 4, "the procedural anti-pattern prompt is flagged (4 hard-coded steps)");

lab.section(`Delegation events${lab.isLive() ? " (live run)" : " (offline replay of a recorded stream)"}`);
let events: string[];
if (lab.isLive()) {
  events = await runLive(options);
} else {
  events = recordedStream().flatMap((m) => describeMessage(m));
  for (const line of events) console.log(`  ${line}`);
  const delegations = events.filter((e) => e.startsWith("DELEGATE"));
  lab.check(delegations.length === 2 && delegations[1].includes("'Task'"), "delegations detected under both names, 'Agent' and 'Task'");
  lab.check(events.some((e) => e.includes("[inside subagent of toolu_A2]")), "parent_tool_use_id marks work done inside a subagent");
}
lab.check(events.some((e) => e.startsWith("RESULT")), "the run ended with a result message");
