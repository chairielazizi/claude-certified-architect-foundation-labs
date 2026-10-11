/**
 * D3.4 - Plan mode for investigation, direct execution for implementation (Claude Agent SDK).
 *
 *   phase 1  permissionMode: "plan"          read-only: explore, compare approaches, return a plan
 *            + read-only explorer subagent   verbose discovery happens in ITS context; a summary returns
 *   (a human approves the plan)
 *   phase 2  permissionMode: "acceptEdits"   execute the APPROVED plan, injected verbatim into the prompt
 *
 * Every run works on a fresh copy of sample-repo/ under .lab-runtime/workspace-ts.
 *
 * Run:  npx tsx planThenExecute.ts          offline: real option objects + a scripted plan -> execute handoff
 *       npx tsx planThenExecute.ts --live   real query() calls (needs the Claude Code runtime + credentials)
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { query, type AgentDefinition, type Options } from "@anthropic-ai/claude-agent-sdk";
import * as lab from "../../shared/typescript/labkit.ts";

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_REPO = path.join(LAB, "sample-repo");
const WORKSPACE = path.join(LAB, ".lab-runtime", "workspace-ts");
const WRITE_TOOLS = ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"];

const TASK =
  "Replace every use of common/legacy_dates.py with the standard library (date.fromisoformat, " +
  "date.isoformat, plain date subtraction), then delete common/legacy_dates.py. Behavior must not " +
  "change: tests/test_callers.py must still pass.";

// A custom read-only explorer. In interactive Claude Code the built-in "Explore" subagent plays this
// role without any definition; in the SDK you can define your own and pin its tools to read-only.
const EXPLORER: AgentDefinition = {
  description: "Read-only dependency explorer. Use it for verbose discovery: finding every caller of a module and how each one uses it.",
  prompt:
    "You map how a module is used across a codebase. Grep for imports and call sites, Read only the lines " +
    "you need, and return a compact summary: one line per caller file listing the helpers it uses and " +
    "anything unusual. Never paste whole files.",
  tools: ["Read", "Grep", "Glob"],
  model: "inherit",
};

const planningPrompt = (task: string) =>
  `${task}\n\nThis is the planning phase. Use the dependency-explorer subagent for discovery so raw ` +
  "search output stays out of this conversation. Then propose a plan: the approach you chose and why " +
  "(name at least one alternative you rejected), every file to change under a '## Files' heading, and " +
  "how to verify. Do not edit anything.";

function planningOptions(workspace: string): Options {
  return {
    cwd: workspace,
    permissionMode: "plan", // Claude can read and design, but cannot modify files
    allowedTools: ["Read", "Grep", "Glob", "Agent"], // "Agent" spawns subagents (formerly "Task")
    disallowedTools: [...WRITE_TOOLS], // belt and braces on top of plan mode
    agents: { "dependency-explorer": EXPLORER },
    settingSources: ["project"], // load sample-repo/CLAUDE.md
    maxTurns: 30,
  };
}

const executionPrompt = (plan: string) =>
  "Execute this approved plan. Follow it step by step; do not re-plan or widen the scope. If a step " +
  "turns out to be wrong, stop and report instead of improvising.\n\n" +
  `<approved_plan>\n${plan}\n</approved_plan>\n\n` +
  "When you are done, run the tests and report the status of each step.";

function executionOptions(workspace: string): Options {
  return {
    cwd: workspace,
    permissionMode: "acceptEdits", // direct execution: file edits are auto-approved
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash(python -m unittest *)", "Bash(rm common/legacy_dates.py)"],
    settingSources: ["project"],
    maxTurns: 40,
  };
}

interface PhaseResult {
  text: string;
  toolsUsed: string[];
  sessionId: string | null;
  edited: string[];
}

async function runLive(prompt: string, options: Options): Promise<PhaseResult> {
  const toolsUsed: string[] = [];
  let planFromTool = "";
  let resultText = "";
  let sessionId: string | null = null;
  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          toolsUsed.push(block.name);
          // plan mode presents its plan through the ExitPlanMode tool
          if (block.name === "ExitPlanMode") planFromTool = String((block.input as { plan?: unknown }).plan ?? "");
        }
      }
    } else if (message.type === "result") {
      sessionId = message.session_id;
      if (message.subtype === "success") resultText = message.result;
    }
  }
  return { text: planFromTool || resultText, toolsUsed, sessionId, edited: [] };
}

// ---------------------------------------------------------------------------
// Offline stand-in for query(): it behaves according to the permission mode it is given
// ---------------------------------------------------------------------------

const IMPORT_RE = /^from common\.legacy_dates import (.+)\n/m;
const REPLACEMENTS: Record<string, string> = {
  parse_date: "date.fromisoformat(text)",
  format_date: "value.isoformat()",
  days_between: "(end - start).days",
};

const readText = (file: string) => readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
const toPosix = (p: string) => p.split(path.sep).join("/");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "__pycache__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** What the explorer subagent reports: each caller file and the legacy helpers it imports. */
function discoverCallers(workspace: string): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const file of walk(workspace).filter((f) => f.endsWith(".py"))) {
    const match = IMPORT_RE.exec(readText(file));
    if (match) callers.set(toPosix(path.relative(workspace, file)), match[1].split(",").map((h) => h.trim()));
  }
  return new Map([...callers].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function makePlan(callers: Map<string, string[]>): string {
  const steps = [...callers].map(([file, helpers], i) => `${i + 1}. ${file}: ${helpers.map((h) => `${h} -> ${REPLACEMENTS[h]}`).join("; ")}`);
  return [
    "## Approach",
    "Migrate each caller directly to the standard library. Rejected alternative: keep legacy_dates.py",
    "as a thin shim over datetime - zero caller churn, but the deprecated module lives on forever.",
    "",
    "## Steps",
    ...steps,
    `${steps.length + 1}. Delete common/legacy_dates.py`,
    `${steps.length + 2}. Verify: python -m unittest discover -s tests -t .`,
    "",
    "## Files",
    ...[...callers.keys()].map((file) => `- ${file}`),
    "- common/legacy_dates.py (delete)",
  ].join("\n");
}

function plannedFiles(plan: string): string[] {
  const section = plan.includes("## Files") ? plan.split("## Files")[1] : "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).split(" ")[0]);
}

function migrateSource(source: string): string {
  let out = source.replace(/parse_date\(/g, "date.fromisoformat(");
  out = out.replace(/format_date\(([^()]+)\)/g, "$1.isoformat()");
  out = out.replace(/days_between\(([^,]+), ([^)]+)\)/g, "($2 - $1).days");
  const replacement = out.includes("date.fromisoformat") ? "from datetime import date\n" : "";
  return out.replace(IMPORT_RE, replacement).replace(/^\n+/, "");
}

function scriptedRun(prompt: string, options: Options, workspace: string): PhaseResult {
  if (options.permissionMode === "plan") {
    const callers = discoverCallers(workspace); // read-only: Grep + Read, delegated to the explorer
    return { text: makePlan(callers), toolsUsed: ["Agent", "ExitPlanMode"], sessionId: "offline-plan-session", edited: [] };
  }
  if (options.permissionMode === "acceptEdits") {
    const match = /<approved_plan>\n([\s\S]*?)\n<\/approved_plan>/.exec(prompt);
    if (!match) return { text: "No approved plan in the prompt; refusing to improvise a migration.", toolsUsed: [], sessionId: "offline-exec-session", edited: [] };
    const edited: string[] = [];
    for (const rel of plannedFiles(match[1])) {
      const file = path.join(workspace, ...rel.split("/"));
      if (rel === "common/legacy_dates.py") unlinkSync(file);
      else writeFileSync(file, migrateSource(readText(file)), "utf-8");
      edited.push(rel);
    }
    return { text: `Executed the plan: ${edited.length} files changed.`, toolsUsed: ["Edit", "Bash"], sessionId: "offline-exec-session", edited };
  }
  throw new Error(`unexpected permissionMode ${String(options.permissionMode)}`);
}

const runPhase = (prompt: string, options: Options, workspace: string): Promise<PhaseResult> =>
  lab.isLive() ? runLive(prompt, options) : Promise.resolve(scriptedRun(prompt, options, workspace));

// ---------------------------------------------------------------------------

function freshWorkspace(): string {
  rmSync(WORKSPACE, { recursive: true, force: true });
  cpSync(SAMPLE_REPO, WORKSPACE, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  return WORKSPACE;
}

function snapshot(workspace: string): string {
  return walk(workspace)
    .map((f) => `${toPosix(path.relative(workspace, f))}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`)
    .join("\n");
}

function describe(options: Options): void {
  const agents = Object.fromEntries(Object.entries(options.agents ?? {}).map(([name, a]) => [name, `tools=${JSON.stringify(a.tools)} model=${a.model}`]));
  console.log("  Options {");
  console.log(`    permissionMode: ${JSON.stringify(options.permissionMode)},`);
  console.log(`    allowedTools: ${JSON.stringify(options.allowedTools)},`);
  console.log(`    disallowedTools: ${JSON.stringify(options.disallowedTools ?? [])},`);
  console.log(`    agents: ${JSON.stringify(agents)},`);
  console.log(`    settingSources: ${JSON.stringify(options.settingSources)}, maxTurns: ${options.maxTurns} }`);
}

async function approve(): Promise<boolean> {
  if (!lab.isLive()) {
    console.log("  [offline] the developer reviews the plan above and approves it");
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Approve this plan and execute it? [y/N] ");
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

lab.banner("D3.4  Plan mode for investigation, then direct execution of the approved plan");
const workspace = freshWorkspace();

lab.section("Phase 1 - plan mode (read-only investigation)");
const planOpts = planningOptions(workspace);
describe(planOpts);
const before = snapshot(workspace);
const planning = await runPhase(planningPrompt(TASK), planOpts, workspace);
console.log(`\nplan returned by phase 1 (tools used: ${JSON.stringify(planning.toolsUsed)}):\n`);
console.log(planning.text.split("\n").map((line) => `    ${line}`).join("\n"));
lab.check(planOpts.permissionMode === "plan", "phase 1 runs with permissionMode 'plan'");
lab.check(
  !WRITE_TOOLS.some((t) => (planOpts.allowedTools ?? []).includes(t)) && WRITE_TOOLS.every((t) => (planOpts.disallowedTools ?? []).includes(t)),
  "phase 1 has no write tools: none allowed, all explicitly disallowed",
);
lab.check(JSON.stringify([...(EXPLORER.tools ?? [])].sort()) === '["Glob","Grep","Read"]', "the explorer subagent is read-only (Read, Grep, Glob)");
lab.check(snapshot(workspace) === before, "planning changed nothing on disk");
if (!lab.isLive()) lab.check(plannedFiles(planning.text).length === 5, "the plan names all 4 callers plus the module to delete");

lab.section("Approval");
if (!(await approve())) {
  console.log("  plan rejected; nothing was executed");
  process.exit(0);
}

lab.section("Phase 2 - direct execution of the approved plan (acceptEdits)");
const execPrompt = executionPrompt(planning.text);
const execOpts = executionOptions(workspace);
describe(execOpts);
lab.check(execOpts.permissionMode === "acceptEdits", "phase 2 runs with permissionMode 'acceptEdits'");
lab.check(execPrompt.includes(planning.text), "phase 2's prompt carries the approved plan verbatim");
const execution = await runPhase(execPrompt, execOpts, workspace);
console.log(`\nphase 2 result: ${execution.text}`);

lab.section("Verify");
const leftovers = walk(workspace)
  .filter((f) => f.endsWith(".py") && readText(f).includes("legacy_dates"))
  .map((f) => toPosix(path.relative(workspace, f)));
console.log(`  files still referencing legacy_dates: ${leftovers.length ? JSON.stringify(leftovers) : "none"}`);
lab.check(!leftovers.length && !existsSync(path.join(workspace, "common", "legacy_dates.py")), "no caller imports legacy_dates, and the module is gone");
console.log("  (the Python twin also runs sample-repo's unit tests before and after the migration)");
if (!lab.isLive()) {
  lab.check(JSON.stringify([...execution.edited].sort()) === JSON.stringify([...plannedFiles(planning.text)].sort()), "execution touched exactly the files in the plan");
  const refused = scriptedRun("Just do the migration.", execOpts, freshWorkspace());
  lab.check(!refused.edited.length && refused.text.includes("No approved plan"), "without an approved plan in the prompt, the executor does not improvise");
}
