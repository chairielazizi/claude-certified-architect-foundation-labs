/**
 * D3.3 - Which .claude/rules/ files load for the files being edited?
 *
 *   .claude/rules/general.md   no paths:  -> loaded at launch, every session
 *   .claude/rules/tests.md     paths: ["**\/*.test.tsx", "**\/*.test.ts"]
 *                              -> loaded only when Claude reads/edits a matching file
 *
 * Run:  npx tsx ruleLoader.ts
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as lab from "../../shared/typescript/labkit.ts";
import { SELF_TEST, globMatch } from "./globMatch.ts";

export const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLE_REPO = path.join(LAB, "example-repo");
export const RUNTIME = path.join(LAB, ".lab-runtime");

export class RuleError extends Error {}

export const tokens = (text: string): number => (text ? Math.max(1, Math.floor(text.length / 4)) : 0);
const readText = (file: string) => readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
const toPosix = (p: string) => p.split(path.sep).join("/");

export class Rule {
  constructor(
    readonly name: string, // path relative to .claude/rules/
    readonly paths: string[], // [] = unconditional
    readonly text: string, // everything that enters context when the rule loads
  ) {}
  get conditional(): boolean {
    return this.paths.length > 0;
  }
  /** The first glob that matches `file`, or undefined. */
  matches(file: string): string | undefined {
    return this.paths.find((p) => globMatch(p, file));
  }
}

/** `paths:` may be a YAML list or one comma-separated string. */
export function parsePaths(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split(",").map((p) => p.trim()).filter(Boolean);
  if (Array.isArray(value) && value.every((p) => typeof p === "string")) return value.map((p) => String(p).trim());
  throw new RuleError(`${where}: paths must be a list of glob strings or a comma-separated string`);
}

export function parseRule(name: string, text: string): Rule {
  if (!text.startsWith("---")) return new Rule(name, [], text);
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new RuleError(`${name}: frontmatter opened with --- but never closed`);
  let meta: unknown;
  try {
    meta = parseYaml(text.slice(3, end)) ?? {};
  } catch (err) {
    // The classic mistake: an unquoted glob that starts with * is a YAML alias, not a string.
    throw new RuleError(`${name}: invalid YAML frontmatter (${(err as Error).name}); quote globs that start with * or {`);
  }
  const record = meta !== null && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
  return new Rule(name, parsePaths(record.paths, name), text);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function loadRules(projectRoot: string): Rule[] {
  const rulesDir = path.join(projectRoot, ".claude", "rules");
  return walk(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseRule(toPosix(path.relative(rulesDir, f)), readText(f)));
}

export interface Activation {
  rule: Rule;
  why: string; // "always" or "<glob> matched <file>"
}

/** Rules in context once Claude has touched these files (unconditional ones are always there). */
export function rulesFor(rules: Rule[], touched: string[]): Activation[] {
  const active: Activation[] = [];
  for (const rule of rules) {
    if (!rule.conditional) {
      active.push({ rule, why: "always (no paths:)" });
      continue;
    }
    for (const file of touched) {
      const glob = rule.matches(file);
      if (glob) {
        active.push({ rule, why: `'${glob}' matched ${file}` });
        break;
      }
    }
  }
  return active;
}

/** Project-relative source files (configuration under .claude/ excluded). */
export function repoFiles(projectRoot: string): string[] {
  return walk(projectRoot)
    .map((f) => toPosix(path.relative(projectRoot, f)))
    .filter((rel) => !rel.split("/").includes(".claude") && path.posix.basename(rel) !== "CLAUDE.md")
    .sort();
}

// name: [files Claude edits, rules expected in context]
export const SESSIONS: Record<string, [string[], string[]]> = {
  "edit a Terraform module": [["terraform/modules/network/main.tf"], ["general.md", "terraform.md"]],
  "edit a component": [["src/components/Button.tsx"], ["general.md", "react-components.md"]],
  "edit a component test": [["src/components/Button.test.tsx"], ["general.md", "tests.md", "react-components.md"]],
  "edit a nested form test": [["src/components/forms/TextField.test.tsx"], ["general.md", "tests.md", "react-components.md"]],
  "edit a library test": [["src/lib/money.test.ts"], ["general.md", "tests.md"]],
  "edit an API handler": [["src/api/orders.ts"], ["general.md", "api.md"]],
  "edit an e2e test": [["e2e/checkout.test.ts"], ["general.md", "tests.md"]],
};

const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function main(): void {
  lab.banner("D3.3  Path-specific rules: which conventions load for which files");

  lab.section("1. Glob matcher self-test (**, *, ?, {a,b}, [!x])");
  for (const [pattern, file, expected] of SELF_TEST) console.log(`  ${pattern.padEnd(26)} ${file.padEnd(42)} ${expected ? "match" : "no match"}`);
  lab.check(SELF_TEST.every(([p, f, expected]) => globMatch(p, f) === expected), `all ${SELF_TEST.length} glob cases behave as expected`);

  lab.section("2. Rules in example-repo/.claude/rules/");
  const rules = loadRules(EXAMPLE_REPO);
  for (const rule of rules) {
    const scope = rule.conditional ? JSON.stringify(rule.paths) : "always (no paths:)";
    console.log(`  ${rule.name.padEnd(22)}${`~${tokens(rule.text)}`.padStart(5)} tok   ${scope}`);
  }
  lab.check(sameSet(rules.filter((r) => !r.conditional).map((r) => r.name), ["general.md"]), "only general.md is unconditional");
  const testsRule = rules.find((r) => r.name === "tests.md");
  lab.check(JSON.stringify(testsRule?.paths) === '["**/*.test.tsx","**/*.test.ts"]', "tests.md uses a YAML block list of two globs");

  lab.section("3. What loads, per editing session");
  const files = repoFiles(EXAMPLE_REPO);
  for (const [title, [touched, expected]] of Object.entries(SESSIONS)) {
    const active = rulesFor(rules, touched);
    console.log(`\n  ${title}: ${touched.join(", ")}`);
    for (const a of active) console.log(`    + ${a.rule.name.padEnd(22)} ${a.why}`);
    lab.check(
      sameSet(active.map((a) => a.rule.name), expected) && touched.every((f) => files.includes(f)),
      `${title}: exactly ${JSON.stringify([...expected].sort())}`,
    );
  }
  const testFiles = files.filter((f) => testsRule?.matches(f));
  const testDirs = new Set(testFiles.map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".")));
  console.log(`\n  tests.md covers ${testFiles.length} test files in ${testDirs.size} directories: ${JSON.stringify(testFiles)}`);
  lab.check(testFiles.length === 5, "one rule file covers every test file, wherever it lives");

  lab.section("4. Frontmatter gotchas (generated under .lab-runtime/)");
  const comma = parseRule("styles.md", '---\npaths: "src/**/*.css, src/**/*.module.css"\n---\n# Styles\n');
  console.log(`  comma-separated string -> ${JSON.stringify(comma.paths)}`);
  lab.check(JSON.stringify(comma.paths) === '["src/**/*.css","src/**/*.module.css"]', "a comma-separated paths string is split into globs");
  const badDir = path.join(RUNTIME, "bad-rules-ts");
  rmSync(badDir, { recursive: true, force: true });
  mkdirSync(path.join(badDir, ".claude", "rules"), { recursive: true });
  writeFileSync(path.join(badDir, ".claude", "rules", "unquoted.md"), "---\npaths: **/*.test.ts\n---\n# Oops\n", "utf-8");
  let error = "";
  try {
    loadRules(badDir);
  } catch (err) {
    error = (err as Error).message;
  }
  console.log(`  unquoted glob -> ${error}`);
  lab.check(error.includes("quote globs"), "an unquoted glob starting with * is a YAML error, caught with a fix-it hint");
}

if (lab.isMain(import.meta.url)) main();
