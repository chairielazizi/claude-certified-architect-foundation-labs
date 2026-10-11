/**
 * Codebase-exploration toolkit shared by the D5.4 demos.
 *
 *  - Read-only tools over the fixture repo (fixtures/shop-repo): glob, grep, read_file.
 *  - Scratchpad tools that persist findings to .lab-runtime/scratchpad.md.
 *  - A generic agent loop that measures how many characters of tool output land in context.
 *  - Scripted stand-ins for Claude. The explorer is model-driven: it traces a flow by reading
 *    a file, parsing its imports and reading what they point to next, and it builds its
 *    findings from the file contents it has actually seen in the conversation.
 */
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";

export const LAB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.join(LAB_DIR, "fixtures", "shop-repo");
export const RUNTIME = path.join(LAB_DIR, ".lab-runtime");
export const SCRATCHPAD = path.join(RUNTIME, "scratchpad.md");

/** Fresh .lab-runtime/ for every run so reruns are deterministic. */
export function resetRuntime(): void {
  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(RUNTIME, { recursive: true });
}

// ---------------------------------------------------------------------------
// Read-only repo tools (Glob / Grep / Read equivalents)
// ---------------------------------------------------------------------------

export function listFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk(REPO, "");
  return out.sort();
}

export function globToRegex(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ".+^$()[]{}|\\".includes(pattern[i]) ? "\\" + pattern[i] : pattern[i];
      i += 1;
    }
  }
  return "^" + out + "$";
}

const readText = (p: string) => readFileSync(path.join(REPO, p), "utf-8").replaceAll("\r\n", "\n");

function toolGlob(pattern: string): string {
  const regex = new RegExp(globToRegex(pattern));
  return listFiles().filter((f) => regex.test(f)).join("\n") || "(no matches)";
}

function toolGrep(pattern: string, dir = ""): string {
  const regex = new RegExp(pattern);
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
  const hits: string[] = [];
  for (const f of listFiles()) {
    if (!f.startsWith(prefix)) continue;
    readText(f)
      .split("\n")
      .forEach((line, n) => {
        if (regex.test(line)) hits.push(`${f}:${n + 1}: ${line.trim()}`);
      });
  }
  return hits.join("\n") || "(no matches)";
}

function toolRead(p: string): [string, boolean] {
  return listFiles().includes(p) ? [readText(p), false] : [`error: no file ${p}`, true];
}

export const EXPLORER_TOOLS: Anthropic.Tool[] = [
  {
    name: "glob",
    description: "List repository files matching a glob pattern, e.g. 'tests/**/*.py'.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "grep",
    description: "Search file contents with a regular expression. Optional path prefix, e.g. 'src'. Returns path:line: text.",
    input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "read_file",
    description: "Read one file by its repository-relative path.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

export const SCRATCHPAD_TOOLS: Anthropic.Tool[] = [
  {
    name: "append_scratchpad",
    description: "Append key findings (exact class names, file paths, constants, call order) to the persistent scratchpad file.",
    input_schema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
  },
  {
    name: "read_scratchpad",
    description: "Read the persistent scratchpad of findings recorded earlier in this session, including before any context reset.",
    input_schema: { type: "object", properties: {} },
  },
];

export type ToolArgs = Record<string, string>;
/** Runs one tool call. May be async (spawn_subagent runs a whole subagent loop). */
export type Executor = (name: string, args: ToolArgs) => [string, boolean] | Promise<[string, boolean]>;

export function execute(name: string, args: ToolArgs): [string, boolean] {
  if (name === "glob") return [toolGlob(args.pattern), false];
  if (name === "grep") return [toolGrep(args.pattern, args.path ?? ""), false];
  if (name === "read_file") return toolRead(args.path);
  if (name === "append_scratchpad") {
    mkdirSync(RUNTIME, { recursive: true });
    appendFileSync(SCRATCHPAD, args.notes.replace(/\n+$/, "") + "\n\n", "utf-8");
    return [`ok: scratchpad is now ${readFileSync(SCRATCHPAD, "utf-8").length} chars`, false];
  }
  if (name === "read_scratchpad") return [existsSync(SCRATCHPAD) ? readFileSync(SCRATCHPAD, "utf-8") : "(scratchpad is empty)", false];
  return [`error: unknown tool ${name}`, true];
}

// ---------------------------------------------------------------------------
// A generic agent loop that measures context growth
// ---------------------------------------------------------------------------

const SAFETY_MAX_ITERATIONS = 30;

export interface AgentRun {
  answer: string;
  calls: string[];
  toolChars: number;
  messages: Anthropic.MessageParam[];
}

export async function runAgent(
  client: lab.MessagesClient,
  system: string,
  prompt: string,
  tools: Anthropic.Tool[],
  executor: Executor = execute,
  onToolResult?: (tool: string, args: ToolArgs) => void,
): Promise<AgentRun> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const calls: string[] = [];
  let toolChars = 0;
  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    const params: lab.CreateParams = { model: lab.MODEL, max_tokens: 16000, system, messages: [...messages] };
    if (tools.length) params.tools = tools;
    const response = await client.messages.create(params);
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return { answer: lab.textOf(response), calls, toolChars, messages };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of lab.toolUses(response)) {
      const args = block.input as ToolArgs;
      const [content, isError] = await executor(block.name, args);
      calls.push(block.name);
      toolChars += content.length; // everything a tool returns stays in THIS agent's context
      results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
      if (onToolResult) onToolResult(block.name, args);
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("agent did not finish");
}

// ---------------------------------------------------------------------------
// Digests: what a careful explorer writes down about a file
// ---------------------------------------------------------------------------

const CONST_RE = /^([A-Z][A-Z0-9_]{2,}) = (.+?)(\s+#.*)?$/gm;
const ATTR_RE = /self\.(\w+) = (\w+)\(/g;
const SELF_CALL_RE = /self\.(\w+)\.(\w+)\(/g;
const DIRECT_CALL_RE = /\b([A-Z]\w+)\(\)\.(\w+)\(/g;
const IMPORT_RE = /^from src\.([\w.]+) import ([\w, ]+)$/gm;

interface Def {
  kind: string;
  name: string;
  methods: string[];
}

/** One line per file: top-level defs/classes (with methods), constants, and outgoing calls. */
export function fileDigest(p: string, content: string): string {
  const defs: Def[] = [];
  for (const line of content.split("\n")) {
    const cls = line.match(/^class (\w+)/);
    const fn = line.match(/^def (\w+)/);
    const method = line.match(/^ {4}def (\w+)\(/);
    const last = defs[defs.length - 1];
    if (cls) defs.push({ kind: "class", name: cls[1], methods: [] });
    else if (fn) defs.push({ kind: "def", name: fn[1], methods: [] });
    else if (method && last && last.kind === "class" && !method[1].startsWith("__")) last.methods.push(method[1]);
  }
  const rendered = defs.map((d) => `${d.kind} ${d.name}` + (d.methods.length ? ` [${d.methods.join(", ")}]` : ""));
  const consts = [...content.matchAll(CONST_RE)].map((m) => `${m[1]} = ${m[2]}`);
  const attrs = new Map([...content.matchAll(ATTR_RE)].map((m) => [m[1], m[2]] as [string, string]));
  const calls = [...content.matchAll(DIRECT_CALL_RE)].map((m) => `${m[1]}.${m[2]}`);
  for (const m of content.matchAll(SELF_CALL_RE)) {
    const owner = attrs.get(m[1]);
    if (owner) calls.push(`${owner}.${m[2]}`);
  }
  let out = `- ${p}: ` + rendered.join(", ");
  if (consts.length) out += "; " + consts.join(", ");
  if (calls.length) out += "; calls " + calls.join(" -> ");
  return out;
}

export function testDigest(p: string, content: string): string {
  const targets = [...content.matchAll(IMPORT_RE)].flatMap((m) => m[2].split(",").map((n) => n.trim()));
  const tests = (content.match(/^def test_/gm) ?? []).length;
  return `- ${p}: ${tests} test(s), targets ${targets.join(", ")}`;
}

const importsOf = (content: string) => [...content.matchAll(IMPORT_RE)].map((m) => "src/" + m[1].replaceAll(".", "/") + ".py");

// ---------------------------------------------------------------------------
// Reading the conversation (what the scripted models "see")
// ---------------------------------------------------------------------------

export interface Exchange {
  name: string;
  args: ToolArgs;
  content: string;
}

/** (tool name, input, result content) for every tool call so far, in order. */
export function exchanges(params: { messages: Anthropic.MessageParam[] }): Exchange[] {
  const pending = new Map<string, { name: string; args: ToolArgs }>();
  const out: Exchange[] = [];
  for (const msg of params.messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") pending.set(block.id, { name: block.name, args: block.input as ToolArgs });
      else if (block.type === "tool_result") {
        const call = pending.get(block.tool_use_id);
        if (call) out.push({ ...call, content: lab.toolResultText(block) });
      }
    }
  }
  return out;
}

function firstPrompt(params: lab.CreateParams): string {
  const content = params.messages[0].content;
  return typeof content === "string" ? content : "";
}

const toolNames = (params: lab.CreateParams) => (params.tools ?? []).map((t) => (t as { name: string }).name);

// ---------------------------------------------------------------------------
// Scripted explorer
// ---------------------------------------------------------------------------

export const EXPLORER_PROMPT =
  "You are a codebase explorer working in a read-only repository. Use glob, grep and read_file to " +
  "answer from the actual code. Report exact class names, file paths and constants, never typical patterns.";
export const SCRATCHPAD_RULES =
  " Record key findings (exact class names, file paths, constants, call order) with append_scratchpad " +
  "before you answer. At the start of a new context, call read_scratchpad before answering anything.";
const TRACES: [string, string, string][] = [
  ["trace refund flow", "Refund flow", "def post_refund"],
  ["trace notification", "Notification flow", "class RefundNotifier"],
];
const TEST_TASK = "find all test files";

type Phase = { action: Anthropic.Message | null; summary: string | null };

function testPhase(seen: Exchange[]): Phase {
  const globs = seen.filter((e) => e.name === "glob" && e.args.pattern.startsWith("tests")).map((e) => e.content);
  if (!globs.length) return { action: lab.message([lab.toolUse("glob", { pattern: "tests/**/*.py" })]), summary: null };
  const reads = new Map(seen.filter((e) => e.name === "read_file").map((e) => [e.args.path, e.content] as [string, string]));
  const listed = globs[0].split("\n");
  const next = listed.find((p) => !reads.has(p));
  if (next) return { action: lab.message([lab.toolUse("read_file", { path: next })]), summary: null };
  const lines = listed.map((p) => testDigest(p, reads.get(p) ?? ""));
  return { action: null, summary: `Test files (${listed.length} found by glob 'tests/**/*.py'):\n` + lines.join("\n") };
}

function tracePhase(seen: Exchange[], label: string, start: string): Phase {
  const greps = seen.filter((e) => e.name === "grep" && e.args.pattern === start).map((e) => e.content);
  if (!greps.length) return { action: lab.message([lab.toolUse("grep", { pattern: start, path: "src" })]), summary: null };
  const reads = new Map(seen.filter((e) => e.name === "read_file").map((e) => [e.args.path, e.content] as [string, string]));
  const order = [greps[0].split(":")[0]];
  for (let i = 0; i < order.length; i++) {
    // breadth-first over imports of the files read so far
    const content = reads.get(order[i]);
    if (content !== undefined) for (const p of importsOf(content)) if (!order.includes(p)) order.push(p);
  }
  const next = order.find((p) => !reads.has(p));
  if (next) return { action: lab.message([lab.toolUse("read_file", { path: next })]), summary: null };
  const lines = order.map((p) => fileDigest(p, reads.get(p) ?? ""));
  return { action: null, summary: `${label} traced from '${start}' (${order.length} files read):\n` + lines.join("\n") };
}

const WINDOW_LINE_RE = /^- (\S+): ([^\n]*)RETURN_WINDOW_DAYS = (\d+)/m;

function windowAnswer(visible: string): string {
  const match = visible.match(WINDOW_LINE_RE);
  if (!match) {
    // Nothing specific in context: this is the drift the exam describes.
    return "Typically a RefundPolicy class in the service layer enforces the refund window, usually 30 days.";
  }
  const [, p, defs, days] = match;
  const gate = [...defs.matchAll(/class (\w+) \[/g)][0][1];
  return `${gate} in ${p} enforces it: RETURN_WINDOW_DAYS = ${days} (days since delivery).`;
}

function scriptedExplorer(params: lab.CreateParams): Anthropic.Message {
  const task = firstPrompt(params);
  const lowered = task.split("\n")[0].toLowerCase(); // the task is the first line; anything below is context
  const seen = exchanges(params);
  const names = seen.map((e) => e.name);
  const available = toolNames(params);

  if (task.includes("Question:")) {
    // a follow-up question in a new context window
    if (available.includes("read_scratchpad") && !names.includes("read_scratchpad")) {
      return lab.message([lab.text("New context: checking my scratchpad first."), lab.toolUse("read_scratchpad", {})]);
    }
    const visible = task + "\n" + seen.map((e) => e.content).join("\n");
    return lab.message([lab.text(windowAnswer(visible))]);
  }

  const summaries: string[] = [];
  if (lowered.includes(TEST_TASK)) {
    const { action, summary } = testPhase(seen);
    if (action) return action;
    if (summary) summaries.push(summary);
  }
  for (const [key, label, start] of TRACES) {
    if (!lowered.includes(key)) continue;
    const { action, summary } = tracePhase(seen, label, start);
    if (action) return action;
    if (summary) summaries.push(summary);
  }
  const notes = summaries.join("\n\n");
  if (available.includes("append_scratchpad") && !names.includes("append_scratchpad")) {
    return lab.message([lab.text("Recording findings before answering."), lab.toolUse("append_scratchpad", { notes })]);
  }
  return lab.message([lab.text(notes)]);
}

// ---------------------------------------------------------------------------
// Scripted analyst (phase 2) and reviewer (crash-recovery demo)
// ---------------------------------------------------------------------------

export const ANALYST_PROMPT =
  "You are a test-gap analyst. Use the tools only for what the provided findings do not already tell you. " +
  "Propose missing test cases with exact values.";
export const REVIEWER_PROMPT = "You review exploration findings for risky couplings. Use only the findings you are given and cite class names.";
const GATE_LINE_RE = /^- (src\/\S+\.py): [^\n]*RETURN_WINDOW_DAYS/m;
const GATE_TEST_RE = /^- (tests\/\S+\.py): [^\n]*targets [^\n]*ReturnEligibilityGate/m;

function scriptedAnalyst(params: lab.CreateParams): Anthropic.Message {
  const prompt = firstPrompt(params);
  const seen = exchanges(params);
  const reads = new Map(seen.filter((e) => e.name === "read_file").map((e) => [e.args.path, e.content] as [string, string]));
  let gatePath = prompt.match(GATE_LINE_RE)?.[1] ?? null;
  if (gatePath === null) {
    const greps = seen.filter((e) => e.name === "grep").map((e) => e.content);
    if (!greps.length) return lab.message([lab.toolUse("grep", { pattern: "RETURN_WINDOW_DAYS =", path: "src" })]);
    gatePath = greps[0].split(":")[0];
  }
  if (!reads.has(gatePath)) return lab.message([lab.toolUse("read_file", { path: gatePath })]);
  let testPath = prompt.match(GATE_TEST_RE)?.[1] ?? null;
  if (testPath === null) {
    for (const [p, c] of reads) if (testPath === null && p.startsWith("tests/") && c.includes("ReturnEligibilityGate")) testPath = p;
  }
  if (testPath === null) {
    const globs = seen.filter((e) => e.name === "glob").map((e) => e.content);
    if (!globs.length) return lab.message([lab.toolUse("glob", { pattern: "tests/**/*.py" })]);
    const unread = globs[0].split("\n").filter((p) => !reads.has(p));
    return lab.message([lab.toolUse("read_file", { path: unread[0] })]);
  }
  if (!reads.has(testPath)) return lab.message([lab.toolUse("read_file", { path: testPath })]);

  const code = reads.get(gatePath) ?? "";
  const tests = reads.get(testPath) ?? "";
  const windowDays = parseInt(code.match(/RETURN_WINDOW_DAYS = (\d+)/)?.[1] ?? "0", 10);
  const strict = /days > RETURN_WINDOW_DAYS/.test(code);
  const covered = [...new Set([...tests.matchAll(/days_ago=(\d+)/g)].map((m) => parseInt(m[1], 10)))].sort((a, b) => a - b);
  const proposals: string[] = [];
  if (!covered.includes(windowDays)) proposals.push(`days_ago=${windowDays} is ${strict ? "accepted" : "rejected"} (the boundary itself)`);
  if (!covered.includes(windowDays + 1)) proposals.push(`days_ago=${windowDays + 1} raises WindowExpired`);
  if (code.includes("NotDelivered") && !tests.includes("NotDelivered")) proposals.push("delivered_on=None raises NotDelivered");
  const head = `Missing tests for ReturnEligibilityGate (RETURN_WINDOW_DAYS = ${windowDays}; existing tests use days_ago=[${covered.join(", ")}]):\n`;
  return lab.message([lab.text(head + proposals.map((p, i) => `${i + 1}. ${p}`).join("\n"))]);
}

function scriptedReviewer(params: lab.CreateParams): Anthropic.Message {
  const findings = firstPrompt(params);
  const risks: string[] = [];
  if (/AcmePayClient\.refund -> LedgerJournal\.record/.test(findings)) {
    risks.push("CreditReversalService calls AcmePayClient.refund before LedgerJournal.record: a ledger failure leaves money refunded but unrecorded.");
  }
  if (findings.includes("MAX_RETRIES = 0") && findings.includes("RefundNotifier")) {
    risks.push("RefundNotifier sends through EmailGateway with MAX_RETRIES = 0: a failed confirmation email is silently dropped after the refund.");
  }
  if (findings.includes("Test files") && !findings.includes("targets RefundNotifier")) {
    risks.push("No test file targets RefundNotifier, so the notification step is untested.");
  }
  if (!risks.length) return lab.message([lab.text("No findings from earlier agents were provided, so I cannot assess couplings.")]);
  return lab.message([lab.text("Risky couplings:\n" + risks.map((r) => `- ${r}`).join("\n"))]);
}

export const COMPACT_PROMPT = "Summarize this exploration session briefly so the work can continue in a fresh context.";
const PATH_RE = /\bsrc\/(\w+)\/\w+\.py\b/g;

/** Keeps the gist and drops the exact names: the way detail erodes when context is compacted. */
function scriptedCompactor(params: lab.CreateParams): Anthropic.Message {
  const transcript = lab.lastUserText(params);
  const matches = [...transcript.matchAll(PATH_RE)];
  const files = [...new Set(matches.map((m) => m[0]))].sort();
  const areas = [...new Set(matches.map((m) => m[1]))].sort();
  return lab.message([
    lab.text(
      `Explored ${files.length} source files (${areas.join(", ")}) and answered how refunds flow through the code. ` +
        "A request goes from the API handler to a refund service, which checks a return policy, calls the " +
        "payment provider, writes the ledger and notifies the customer.",
    ),
  ]);
}

/** One responder for every role; the system prompt says which role this call is. */
export function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  if (system.startsWith(COMPACT_PROMPT)) return scriptedCompactor(params);
  if (system.startsWith(ANALYST_PROMPT)) return scriptedAnalyst(params);
  if (system.startsWith(REVIEWER_PROMPT)) return scriptedReviewer(params);
  return scriptedExplorer(params);
}
