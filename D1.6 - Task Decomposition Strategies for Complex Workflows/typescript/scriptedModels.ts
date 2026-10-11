/**
 * Offline stand-ins for Claude in the D1.6 demos (one responder per role, chosen by system prompt).
 *
 * All of them are model-driven: they only use what is in the request they receive. That is what
 * makes the demos honest. The per-file reviewer cannot flag a cross-file bug because the other
 * file is not in its prompt, and the planner can only re-plan from discoveries it is shown.
 *
 * Roles:
 *   per-file reviewer      one file in -> local issues, exports, outgoing calls (JSON)
 *   integration reviewer   per-file reports in -> cross-file mismatches (JSON)
 *   single-pass reviewer   every file in one prompt; simulates attention dilution (sample Q12)
 *   test planner           repo map (+ discoveries) in -> prioritized task plan (JSON)
 *   test worker            one module + available fixtures in -> done | blocked + missing (JSON)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import {
  type Issue,
  type ModuleInfo,
  checkCall,
  extractCalls,
  localIssues,
  moduleDocstring,
  parseClasses,
  parseDefs,
  parseImports,
  splitArgs,
} from "./codeAnalysis.ts";

/** Simulated attention budget for the single-pass reviewer: files after the first two get a skim.
 * Real dilution is not a hard cutoff, it is inconsistent depth, but the effect on the output
 * (some files reviewed well, obvious bugs missed elsewhere) is the same. */
export const SINGLE_PASS_DEEP_FILES = 2;

export interface ExternalCall {
  symbol: string;
  module: string;
  call: string;
}
export interface FileReport {
  file: string;
  summary: string;
  local_issues: Issue[];
  exports: string[];
  external_calls: ExternalCall[];
}
export interface CrossFileIssue {
  caller: string;
  callee: string;
  issue: string;
}
export interface Finding {
  file: string;
  issue: string;
}
export interface Task {
  id: string;
  kind: "write_tests" | "build_fixture";
  target: string;
  priority: number;
  depends_on: string[];
  reason: string;
}
export interface Missing {
  fixture: string;
  reason: string;
}
export interface WorkerResult {
  status: "done" | "blocked";
  tests_written: string[];
  missing: Missing[];
}
export interface Plan {
  tasks: Task[];
  notes: string;
}
interface PlannerState {
  repo_map: Record<string, ModuleInfo>;
  done?: Task[];
  pending?: Task[];
  discovery?: { task_id: string; target: string; missing: Missing[] };
}

export function filesIn(prompt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of prompt.matchAll(/^### FILE: (\S+)\n([\s\S]*?)^### END FILE/gm)) out[m[1]] = m[2];
  return out;
}

// Matches what output_config json_schema guarantees in live mode: one JSON text block.
const jsonReply = (payload: unknown) => lab.message([lab.text(JSON.stringify(payload))]);

function jsonAfter<T>(marker: string, prompt: string): T {
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).trim()) as T;
}

// ---------------------------------------------------------------------------
// Reviewers (part a)
// ---------------------------------------------------------------------------

export function perFileReview(name: string, source: string): FileReport {
  const defs = parseDefs(source);
  const localNames = new Set(defs.map((d) => d.name));
  const calls: ExternalCall[] = [];
  const unverifiable: string[] = [];
  for (const [module, names] of parseImports(source)) {
    for (const symbol of names) {
      for (const args of extractCalls(source, symbol)) {
        calls.push({ symbol, module, call: `${symbol}(${args})` });
        if (!localNames.has(symbol)) unverifiable.push(`${module}.${symbol}`);
      }
    }
  }
  let summary = moduleDocstring(source) || `${name} module`;
  if (unverifiable.length) {
    // Honest limit of a focused pass: the callee's signature is not in this prompt.
    summary += ` Calls ${[...new Set(unverifiable)].sort().join(", ")} (signature not visible in this file).`;
  }
  return {
    file: name,
    summary,
    local_issues: localIssues(source),
    exports: [...defs.map((d) => d.signature), ...parseClasses(source).map((c) => `class ${c}`)],
    external_calls: calls,
  };
}

export function integrationReview(reports: FileReport[]): { cross_file_issues: CrossFileIssue[] } {
  // Interface table built only from what the per-file passes exported.
  const signatures = new Map<string, { signature: string; params: string[] }>();
  for (const report of reports) {
    const module = report.file.replace(/\.py$/, "");
    for (const sig of report.exports) {
      const m = sig.match(/^(\w+)\((.*)\)$/);
      if (m) signatures.set(`${module}.${m[1]}`, { signature: sig, params: splitArgs(m[2]) });
    }
  }

  const issues: CrossFileIssue[] = [];
  for (const report of reports) {
    const hidesErrors = report.local_issues.some((i) => i.issue.includes("bare `except:`"));
    for (const call of report.external_calls) {
      const known = signatures.get(`${call.module}.${call.symbol}`);
      if (!known) continue;
      const args = splitArgs(extractCalls(call.call, call.symbol)[0] ?? "");
      const problems = checkCall(args, known.params);
      if (problems.length) {
        let text =
          `${report.file} calls ${call.call} but ${call.module}.py now defines ` +
          `${known.signature}: ${problems.join("; ")}. This raises TypeError at runtime`;
        text += hidesErrors ? `, which ${report.file}'s bare except turns into a silent 500.` : ".";
        issues.push({ caller: report.file, callee: `${call.module}.${call.symbol}`, issue: text });
      }
    }
  }
  return { cross_file_issues: issues };
}

export function singlePassReview(files: Record<string, string>): { findings: Finding[] } {
  const findings: Finding[] = [];
  Object.entries(files).forEach(([name, source], index) => {
    if (index < SINGLE_PASS_DEEP_FILES) findings.push(...localIssues(source).map((i) => ({ file: name, issue: i.issue })));
    else findings.push({ file: name, issue: "Looks fine." }); // superficial skim
  });
  return { findings };
}

// ---------------------------------------------------------------------------
// Planner and worker (part b)
// ---------------------------------------------------------------------------

/** How the worker recognises what a test for a module needs (it reads the source). */
const FIXTURE_HINTS: [RegExp, string, string][] = [
  [/\bsqlite3\.connect\(/, "tmp_sqlite", "opens a real sqlite file; tests need a temporary database"],
  [/\bdb\.connect\(/, "fake_db", "calls db.connect(); tests need an in-memory DB fake"],
  [/\brequests\.(post|get)\(/, "gateway_stub", "calls the payment gateway over HTTP; tests need a stub"],
  [/\bdatetime\.now\(/, "frozen_clock", "depends on the current time; tests need a frozen clock"],
  [/\bsmtplib\.SMTP\(/, "smtp_stub", "opens an SMTP connection; tests need a stub mail server"],
];

/** How the planner generalises a discovery to modules that have not run yet (from the repo map). */
const FIXTURE_SIGNALS: Record<string, (m: ModuleInfo) => boolean> = {
  tmp_sqlite: (m) => m.external.includes("sqlite3"),
  fake_db: (m) => m.imports.includes("db.py"),
  gateway_stub: (m) => m.external.includes("requests"),
  frozen_clock: (m) => m.external.includes("datetime"),
  smtp_stub: (m) => m.external.includes("smtplib"),
};

/** Fixtures first (most dependents first), then modules by impact; renumber priorities. */
function prioritize(tasks: Task[], repoMap: Record<string, ModuleInfo>): Task[] {
  const dependents = (task: Task) => tasks.filter((t) => t.depends_on.includes(task.id)).length;
  const key = (task: Task): [number, number, string] =>
    task.kind === "build_fixture" ? [0, -dependents(task), task.target] : [1, -repoMap[task.target].impact, task.target];
  const ordered = [...tasks].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  });
  ordered.forEach((task, i) => (task.priority = i + 1));
  return ordered;
}

export function initialPlan(repoMap: Record<string, ModuleInfo>): Plan {
  const names = Object.keys(repoMap);
  const skipped = names.filter((n) => repoMap[n].has_tests);
  const targets = names
    .filter((n) => !repoMap[n].has_tests)
    .sort((a, b) => repoMap[b].impact - repoMap[a].impact || (a < b ? -1 : a > b ? 1 : 0));
  const tasks = targets.map((name, i): Task => ({
    id: `T${i + 1}`,
    kind: "write_tests",
    target: name,
    priority: i + 1,
    depends_on: [],
    reason: `impact ${repoMap[name].impact}: fan-in ${repoMap[name].fan_in}, criticality ${repoMap[name].criticality}, no tests`,
  }));
  return { tasks, notes: `Skipped ${skipped.join(", ")} (already has tests).` };
}

export function replan(state: PlannerState): Plan {
  const repoMap = state.repo_map;
  const pending: Task[] = (state.pending ?? []).map((t) => ({ ...t, depends_on: [...t.depends_on] }));
  const done = state.done ?? [];
  const discovery = state.discovery;
  if (!discovery) return { tasks: pending, notes: "nothing discovered" };
  const known: Record<string, string> = {};
  for (const t of [...pending, ...done]) if (t.kind === "build_fixture") known[t.target] = t.id;
  let nextF = 1 + [...pending, ...done].filter((t) => t.kind === "build_fixture").length;
  const notes: string[] = [];
  for (const missing of discovery.missing) {
    const fixture = missing.fixture;
    if (!(fixture in known)) {
      known[fixture] = `F${nextF++}`;
      pending.push({
        id: known[fixture],
        kind: "build_fixture",
        target: fixture,
        priority: 0,
        depends_on: [],
        reason: `discovered while testing ${discovery.target}: ${missing.reason}`,
      });
    }
    // Generalise: every pending module with the same signal will need this fixture too.
    const signal = FIXTURE_SIGNALS[fixture] ?? (() => false);
    const affected: string[] = [];
    for (const task of pending) {
      if (task.kind !== "write_tests") continue;
      const needs = task.target === discovery.target || signal(repoMap[task.target]);
      if (needs && !task.depends_on.includes(known[fixture])) {
        task.depends_on = [...task.depends_on, known[fixture]];
        affected.push(task.target);
      }
    }
    notes.push(`${known[fixture]} ${fixture} now blocks ${affected.join(", ") || "nothing new"}`);
  }
  return { tasks: prioritize(pending, repoMap), notes: notes.join("; ") };
}

export function worker(task: Task, source: string, available: string[]): WorkerResult {
  if (task.kind === "build_fixture") return { status: "done", tests_written: [`tests/conftest.py::${task.target}`], missing: [] };
  const needs = FIXTURE_HINTS.filter(([pattern]) => pattern.test(source));
  const missing = needs
    .filter(([, fixture]) => !available.includes(fixture))
    .map(([, fixture, reason]) => ({ fixture, reason: `${task.target} ${reason}` }));
  if (missing.length) return { status: "blocked", tests_written: [], missing };
  const module = task.target.replace(/\.py$/, "");
  return { status: "done", tests_written: parseDefs(source).map((d) => `tests/test_${module}.py::test_${d.name}`), missing: [] };
}

// ---------------------------------------------------------------------------
// The responder: dispatch on the system prompt, read only the request
// ---------------------------------------------------------------------------

export function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  const prompt = lab.lastUserText(params);
  if (system.startsWith("PER-FILE REVIEWER")) {
    const entries = Object.entries(filesIn(prompt));
    if (entries.length !== 1) throw new Error("per-file reviewer expects exactly one file");
    return jsonReply(perFileReview(entries[0][0], entries[0][1]));
  }
  if (system.startsWith("INTEGRATION REVIEWER")) return jsonReply(integrationReview(jsonAfter<FileReport[]>("PER-FILE REPORTS:", prompt)));
  if (system.startsWith("SINGLE-PASS REVIEWER")) return jsonReply(singlePassReview(filesIn(prompt)));
  if (system.startsWith("TEST PLANNER")) {
    const state = jsonAfter<PlannerState>("STATE:", prompt);
    return jsonReply(state.discovery ? replan(state) : initialPlan(state.repo_map));
  }
  if (system.startsWith("TEST WORKER")) {
    const state = jsonAfter<{ task: Task; source: string; available_fixtures: string[] }>("STATE:", prompt);
    return jsonReply(worker(state.task, state.source, state.available_fixtures));
  }
  throw new Error(`No scripted role for system prompt: ${system.slice(0, 40)}`);
}
