/**
 * The auth-investigation agent used by both D1.7 demos: tools, a model-driven scripted model, and
 * the helpers that turn an instruction into "which files do I need to (re-)read".
 *
 * The scripted model decides from the conversation, like Claude would:
 *   - a first instruction          -> list_files, then read every file
 *   - "Since our last session ..." -> read ONLY the files the message names
 *   - "STRUCTURED SUMMARY ..."     -> read ONLY the files under "Files to re-read"
 *   - "Strategy A/B ..." (fork)    -> no tools; plan tests from the findings already in context
 * and ends each analysis with a machine-readable line:  FINDINGS_JSON: {"auth/x.py": [...]}
 */
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import type { Findings } from "./sessionRegistry.ts";
import { listFiles } from "./workspace.ts";

export const SYSTEM_PROMPT =
  "You are investigating the auth package of a codebase for security issues. Use list_files and " +
  "read_file; never guess file contents. When you finish an analysis, end your reply with one line " +
  'exactly like: FINDINGS_JSON: {"auth/file.py": ["finding", ...]} covering every file you read in ' +
  "this turn (use an empty list when a file has no issues).";

export const INVESTIGATE = "Start a security review of the auth package in this workspace. Read every file before concluding.";
export const STRATEGIES: Record<string, string> = {
  "strategy-a": "Strategy A: plan unit tests with mocks for the open findings. Name the first three tests.",
  "strategy-b":
    "Strategy B: plan integration tests against a throwaway IdP and sqlite DB for the open findings. " +
    "Name the first three tests.",
};

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List every Python file in the workspace (paths relative to the workspace root).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read one file from the workspace by its relative path, e.g. auth/login.py.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path such as auth/login.py" } },
      required: ["path"],
    },
  },
];

// [pattern that must match, pattern that must NOT match or null, finding]. Stand-in for real analysis.
const RULES: [RegExp, RegExp | null, string][] = [
  [/password == stored\["password"\]/m, null, "plaintext password comparison with == (store hashes, compare in constant time)"],
  [/random\.random\(\)/m, null, "session ids from random.random() are predictable (use secrets.token_urlsafe)"],
  [/jwt\.encode\(/m, /"exp"/m, "JWTs have no exp claim, so tokens never expire"],
  [/^SECRET = "/m, null, "signing secret is hard-coded in source"],
  [/startswith\("\/pub"\)/m, null, "auth bypass prefix '/pub' also matches '/publish' and '/pub-admin'"],
  [/verify=False/m, null, "TLS certificate verification is disabled (verify=False)"],
];

export function analyzeSource(text: string): string[] {
  return RULES.filter(([pattern, absent]) => pattern.test(text) && !(absent && absent.test(text))).map(([, , finding]) => finding);
}

export function executeTool(root: string, name: string, input: Record<string, unknown>): [string, boolean] {
  if (name === "list_files") return [JSON.stringify(listFiles(root)), false];
  if (name === "read_file") {
    const target = path.resolve(root, String(input.path ?? ""));
    const rel = path.relative(path.resolve(root), target);
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    if (!inside || !existsSync(target) || !statSync(target).isFile()) {
      return [JSON.stringify({ error: `No such file in workspace: ${String(input.path)}` }), true];
    }
    return [readFileSync(target, "utf-8"), false];
  }
  return [JSON.stringify({ error: `Unknown tool ${name}` }), true];
}

// ---------------------------------------------------------------------------
// Instruction -> files to read; findings formatting
// ---------------------------------------------------------------------------

function bulletsAfter(heading: string, text: string): string[] {
  const block = text.slice(text.indexOf(heading)).split("\n").slice(1);
  const paths: string[] = [];
  for (const line of block) {
    if (!line.startsWith("- ")) break;
    paths.push(line.slice(2).split(" ")[0]);
  }
  return paths;
}

/** Files the instruction asks to (re-)read; null means "discover them with list_files". */
export function targetsFor(instruction: string): string[] | null {
  if (instruction.startsWith("Since our last session")) {
    return instruction
      .split("\n")
      .filter((l) => l.startsWith("- ") && !l.includes("(deleted"))
      .map((l) => l.slice(2).split(" ")[0]);
  }
  if (instruction.startsWith("STRUCTURED SUMMARY")) return bulletsAfter("Files to re-read:", instruction);
  return null;
}

export const isStrategyRequest = (instruction: string) => instruction.startsWith("Strategy ");

export function formatFindings(findings: Findings): string {
  const lines = [`Analysed ${Object.keys(findings).length} file(s):`];
  for (const [file, issues] of Object.entries(findings)) lines.push(`- ${file}: ${issues.length ? issues.join("; ") : "no issues"}`);
  lines.push(`FINDINGS_JSON: ${JSON.stringify(findings)}`);
  return lines.join("\n");
}

/** The last FINDINGS_JSON line of a reply ({} if the model did not produce one). */
export function parseFindings(text: string): Findings {
  const matches = [...text.matchAll(/^FINDINGS_JSON:\s*(\{.*\})\s*$/gm)];
  if (!matches.length) return {};
  try {
    return JSON.parse(matches[matches.length - 1][1]) as Findings;
  } catch {
    return {};
  }
}

/** The answer a fork gives: a test plan derived from the shared analysis baseline. */
export function strategyPlan(instruction: string, findings: Findings): string {
  if (instruction.startsWith("Strategy A")) {
    // One isolated test per open finding, collaborators mocked.
    const items = Object.entries(findings)
      .flatMap(([file, issues]) => issues.map((issue) => [file, issue] as [string, string]))
      .slice(0, 3);
    const tests = items.map(([file, issue], i) => `${i + 1}. test_${path.posix.basename(file, ".py")}_${i + 1} (unit, mocked): ${issue}`);
    return `Strategy A - unit tests with mocks (jwt, random, bcrypt patched). First tests:\n${tests.join("\n")}`;
  }
  // One end-to-end flow per pair of files with open findings, real collaborators.
  const files = Object.entries(findings)
    .filter(([, issues]) => issues.length)
    .map(([file]) => file);
  const pairs: string[][] = [];
  for (let i = 0; i < files.length; i += 2) pairs.push(files.slice(i, i + 2));
  const tests = pairs.slice(0, 3).map((pair, i) => `${i + 1}. test_flow_${i + 1}_end_to_end: drives ${pair.join(" + ")} together`);
  return `Strategy B - integration tests against a throwaway IdP and sqlite DB. First tests:\n${tests.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Scripted model (offline stand-in for Claude)
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;
const blocksOf = (m: Anthropic.MessageParam): Block[] => (typeof m.content === "string" ? [] : (m.content as unknown as Block[]));

/** Merge every FINDINGS_JSON the assistant produced so far (later ones win). */
export function findingsInContext(messages: Anthropic.MessageParam[]): Findings {
  const merged: Findings = {};
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = blocksOf(m)
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");
    Object.assign(merged, parseFindings(text));
  }
  return merged;
}

export function scriptedInvestigator(params: lab.CreateParams): Anthropic.Message {
  const messages = params.messages;
  // Index of the latest user message that is an instruction (text), not tool results.
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "user" && typeof m.content === "string") start = i;
  });
  const instruction = messages[start].content as string;

  if (isStrategyRequest(instruction)) return lab.message([lab.text(strategyPlan(instruction, findingsInContext(messages.slice(0, start))))]);

  // What has happened since this instruction: which tools ran and what they returned.
  const calls: Record<string, Block> = {};
  const results: Record<string, string> = {};
  for (const m of messages.slice(start + 1)) {
    for (const b of blocksOf(m)) {
      if (b.type === "tool_use") calls[String(b.id)] = b;
      else if (b.type === "tool_result") results[String(b.tool_use_id)] = String(b.content ?? "");
    }
  }
  const read: Record<string, string> = {};
  const listed: string[][] = [];
  for (const [id, text] of Object.entries(results)) {
    const call = calls[id];
    if (call.name === "read_file") read[String((call.input as Record<string, unknown>).path)] = text;
    if (call.name === "list_files") listed.push(JSON.parse(text) as string[]);
  }

  let targets = targetsFor(instruction);
  if (targets === null) {
    if (!listed.length) return lab.message([lab.text("Let me see which files exist."), lab.toolUse("list_files", {})]);
    targets = listed[listed.length - 1];
  }
  const pending = targets.filter((t) => !(t in read));
  // Read every remaining file in ONE turn (parallel tool calls).
  if (pending.length) return lab.message(pending.map((p) => lab.toolUse("read_file", { path: p })));
  const findings: Findings = {};
  for (const t of targets) findings[t] = analyzeSource(read[t]);
  return lab.message([lab.text(formatFindings(findings))]);
}

/** What the scripted investigator would conclude for one prompt, without the tool loop. Used by
 * the offline stand-in for the Agent SDK, where Claude Code runs the tools itself. */
export function offlineAnswer(root: string, instruction: string, contextFindings: Findings): string {
  if (isStrategyRequest(instruction)) return strategyPlan(instruction, contextFindings);
  const targets = targetsFor(instruction) ?? listFiles(root);
  const findings: Findings = {};
  for (const t of targets) findings[t] = analyzeSource(readFileSync(path.join(root, t), "utf-8"));
  return formatFindings(findings);
}
