/**
 * Small, regex-based reading of the fixture Python files (identical logic in code_analysis.py).
 *
 * Two users:
 *  - the deterministic "map the structure" step of the adaptive plan (import graph, fan-in,
 *    existing tests, criticality tags); in a real agent this is Glob/Grep/Read tool work;
 *  - the scripted reviewers, as their way of "reading" code offline. They can only analyse what
 *    is in their prompt, which is exactly why a per-file pass cannot see a cross-file bug.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export interface Issue {
  line: number;
  issue: string;
}

export interface FunctionDef {
  name: string;
  params: string[];
  signature: string;
}

// Local (single-file) review rules the scripted reviewer applies.
const LOCAL_RULES: [RegExp, string][] = [
  [/^\s*except\s*:\s*$/, "bare `except:` swallows every error (TypeError included) and hides the cause"],
  [/^def \w+\(.*=\s*(\[\]|\{\})/, "mutable default argument is shared between calls (and mutated here)"],
  [/\bif \w+ <= len\(/, "off-by-one: index == len(...) passes the check, then raises IndexError"],
];

/** name -> source for the top-level .py files of a directory, sorted by name. */
export function readDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".py")).sort()) {
    out[name] = readFileSync(path.join(dir, name), "utf-8").replace(/\r\n/g, "\n");
  }
  return out;
}

export function moduleDocstring(source: string): string {
  const match = source.match(/^"""(.*?)(?:"""|$)/m);
  return match ? match[1].trim() : "";
}

/** [module, imported names]; `import x` gives [x, []]. */
export function parseImports(source: string): [string, string[]][] {
  const found: [string, string[]][] = [];
  for (const line of source.split("\n")) {
    const from = line.match(/^from (\w+) import (.+)$/);
    const plain = line.match(/^import (\w+)\s*$/);
    if (from) found.push([from[1], from[2].split(",").map((n) => n.trim())]);
    else if (plain) found.push([plain[1], []]);
  }
  return found;
}

/** Split on top-level commas (ignores commas inside brackets and quotes). */
export function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Top-level functions: name, raw params and the signature string. */
export function parseDefs(source: string): FunctionDef[] {
  return [...source.matchAll(/^def (\w+)\((.*)\):/gm)].map((m) => ({
    name: m[1],
    params: splitArgs(m[2]),
    signature: `${m[1]}(${m[2]})`,
  }));
}

export function parseClasses(source: string): string[] {
  return [...source.matchAll(/^class (\w+)/gm)].map((m) => m[1]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Argument text of every call `name(...)`, with balanced parentheses (definitions skipped). */
export function extractCalls(source: string, name: string): string[] {
  const calls: string[] = [];
  for (const m of source.matchAll(new RegExp(`\\b${escapeRe(name)}\\(`, "g"))) {
    const start = m.index ?? 0;
    if (source.slice(Math.max(0, start - 4), start) === "def ") continue;
    const open = start + m[0].length;
    let depth = 1;
    let i = open;
    while (i < source.length && depth) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    calls.push(source.slice(open, i - 1));
  }
  return calls;
}

/** Problems with calling a function declared with `params` using `args`. */
export function checkCall(args: string[], params: string[]): string[] {
  const names = params.map((p) => p.split("=")[0].trim());
  const required = names.filter((n, i) => !params[i].includes("=") && !n.startsWith("*"));
  const isKeyword = (a: string) => /^\w+\s*=(?!=)/.test(a);
  const keyword = args.filter(isKeyword).map((a) => (a.match(/^(\w+)/) ?? ["", ""])[1]);
  const positional = args.filter((a) => !isKeyword(a));
  const problems: string[] = [];
  if (positional.length > names.length) problems.push(`${positional.length} positional args for ${names.length} params`);
  for (const k of keyword) if (!names.includes(k)) problems.push(`unknown keyword '${k}'`);
  const supplied = new Set([...names.slice(0, positional.length), ...keyword]);
  for (const r of required) if (!supplied.has(r)) problems.push(`missing required '${r}'`);
  return problems;
}

export function localIssues(source: string): Issue[] {
  const issues: Issue[] = [];
  source.split("\n").forEach((line, index) => {
    for (const [rule, message] of LOCAL_RULES) if (rule.test(line)) issues.push({ line: index + 1, issue: message });
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Structure mapping for the adaptive test plan
// ---------------------------------------------------------------------------

export interface ModuleInfo {
  imports: string[];
  external: string[];
  criticality: string;
  has_tests: boolean;
  functions: string[];
  fan_in: number;
  impact: number;
}

const CRITICALITY_WEIGHT: Record<string, number> = { high: 6, medium: 3, low: 1 };

/** Fan-in (how much depends on it) + business criticality + "has no tests yet". */
export function impactScore(m: ModuleInfo): number {
  return m.fan_in * 2 + (CRITICALITY_WEIGHT[m.criticality] ?? 1) + (m.has_tests ? 0 : 4);
}

/** module file -> imports, external deps, fan-in, criticality tag, existing tests, impact. */
export function mapRepo(repo: string): Record<string, ModuleInfo> {
  const sources = readDir(repo);
  const stems = new Set(Object.keys(sources).map((n) => n.replace(/\.py$/, "")));
  const testsDir = path.join(repo, "tests");
  const tested = new Set(
    existsSync(testsDir)
      ? readdirSync(testsDir)
          .filter((f) => /^test_.*\.py$/.test(f))
          .map((f) => f.replace(/^test_/, "").replace(/\.py$/, ""))
      : [],
  );
  const info: Record<string, ModuleInfo> = {};
  for (const [name, source] of Object.entries(sources)) {
    const modules = [...new Set(parseImports(source).map(([mod]) => mod))];
    const tag = source.match(/#\s*criticality:\s*(\w+)/);
    info[name] = {
      imports: modules.filter((m) => stems.has(m)).map((m) => `${m}.py`).sort(),
      external: modules.filter((m) => !stems.has(m)).sort(),
      criticality: tag ? tag[1] : "low",
      has_tests: tested.has(name.replace(/\.py$/, "")),
      functions: parseDefs(source).map((d) => d.name),
      fan_in: 0,
      impact: 0,
    };
  }
  for (const [name, module] of Object.entries(info)) {
    module.fan_in = Object.values(info).filter((other) => other.imports.includes(name)).length;
    module.impact = impactScore(module);
  }
  return info;
}
