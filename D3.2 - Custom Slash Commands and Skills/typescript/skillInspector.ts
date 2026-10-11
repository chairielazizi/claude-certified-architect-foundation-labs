/**
 * D3.2 - Inspect custom slash commands and skills the way Claude Code discovers them.
 *
 *   .claude/commands/<name>.md          project command  -> /name   shared via git (the team)
 *   ~/.claude/commands/<name>.md        personal command -> /name   only you
 *   .claude/skills/<name>/SKILL.md      project skill    -> /name   shared via git (the team)
 *   ~/.claude/skills/<name>/SKILL.md    personal skill   -> /name   only you
 *
 * Parses frontmatter, validates known fields, resolves name collisions (a skill beats a command with
 * the same name; a personal skill beats a project skill with the same name), reports which skills run
 * forked and which tools they pre-approve, and renders argument placeholders.
 *
 * Run:  npx tsx skillInspector.ts
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as lab from "../../shared/typescript/labkit.ts";

export const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLE_REPO = path.join(LAB, "example-repo");
export const USER_HOME = path.join(LAB, "user-home-example");
export const FIXTURES = path.join(LAB, "fixtures");
export const RUNTIME = path.join(LAB, ".lab-runtime");

const SKILL_FIELDS = new Set([
  "name", "description", "argument-hint", "arguments", "allowed-tools", "model",
  "disable-model-invocation", "user-invocable", "context", "agent", "paths",
]);
const COMMAND_FIELDS = new Set([...SKILL_FIELDS].filter((f) => f !== "name" && f !== "paths"));
const BUILT_IN_AGENTS = new Set(["Explore", "Plan", "general-purpose"]);
const READ_ONLY_AGENTS = new Set(["Explore", "Plan"]); // their tool set has no Write/Edit
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const KNOWN_TOOLS = new Set([
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch",
  "NotebookEdit", "Agent", "Task", "TodoWrite", "Skill",
]);
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // lowercase letters, digits, hyphens; max 64 chars
const TOOL_RE = /^([A-Za-z_]\w*)(?:\((.*)\))?$/; // Tool or Tool(specifier), e.g. Bash(git diff *)
const SHELL_RE = /(?<=^|\s)!`([^`]+)`/gm; // !`cmd` at line start or after whitespace
const POSITIONAL_RE = /\$ARGUMENTS\[(\d+)\]|\$(\d+)/g;
const ESCAPED_DOLLAR = "\u0000DOLLAR\u0000"; // \$ in a skill means a literal dollar sign

export function readText(file: string): string {
  return readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
}

export function splitFrontmatter(text: string): [Record<string, unknown>, string] {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const meta: unknown = parseYaml(text.slice(3, end)) ?? {};
      const isObject = meta !== null && typeof meta === "object" && !Array.isArray(meta);
      return [isObject ? (meta as Record<string, unknown>) : {}, text.slice(end + 4).replace(/^\n+/, "")];
    }
  }
  return [{}, text];
}

/** YAML list or space/comma-separated string; `Bash(git diff *)` stays ONE entry despite its spaces. */
export function splitList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const items: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of String(value)) {
    depth += (ch === "(" ? 1 : 0) - (ch === ")" ? 1 : 0);
    if (depth === 0 && (/\s/.test(ch) || ch === ",")) {
      if (current) items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return current ? [...items, current] : items;
}

/** "[ComponentName] [directory]" -> ["ComponentName", "directory"]. */
export function hintSlots(hint: string): string[] {
  const bracketed = [...hint.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  return bracketed.length ? bracketed : hint.split(/\s+/).filter(Boolean);
}

export class Entry {
  constructor(
    readonly name: string,
    readonly kind: "skill" | "command",
    readonly scope: "project" | "personal",
    readonly file: string,
    readonly meta: Record<string, unknown>,
    readonly body: string,
  ) {}

  get slash(): string {
    return `/${this.name}`;
  }
  get allowedTools(): string[] {
    return splitList(this.meta["allowed-tools"]);
  }
  get argumentNames(): string[] {
    return splitList(this.meta.arguments);
  }
  get forked(): boolean {
    return this.meta.context === "fork";
  }
  /** Which subagent runs a forked skill (general-purpose when `agent:` is omitted). */
  get agent(): string | null {
    return this.forked ? String(this.meta.agent ?? "general-purpose") : null;
  }
  get invocation(): string {
    const byUser = this.meta["user-invocable"] !== false;
    const byModel = this.meta["disable-model-invocation"] !== true;
    if (byUser && byModel) return "you or Claude";
    if (byUser) return "you only";
    return byModel ? "Claude only" : "nobody";
  }
  /** Positional slots ($0, $ARGUMENTS[N]) and named arguments are required; see the Python twin. */
  get requiredArgs(): number {
    const body = this.body.split("\\$").join("");
    const used = [...body.matchAll(POSITIONAL_RE)].map((m) => Number(m[1] ?? m[2]) + 1);
    let needed = Math.max(0, this.argumentNames.length, ...used);
    const hint = String(this.meta["argument-hint"] ?? "");
    if (needed === 0 && body.includes("$ARGUMENTS") && hint) {
      needed = hintSlots(hint).filter((s) => !s.toLowerCase().startsWith("optional")).length;
    }
    return needed;
  }
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Every command and skill visible to one developer (project + their personal ones). */
export function discover(projectRoot: string, userHome: string | null): Entry[] {
  const found: Entry[] = [];
  const scopes: Array<["project" | "personal", string]> = [["project", path.join(projectRoot, ".claude")]];
  if (userHome) scopes.push(["personal", path.join(userHome, ".claude")]);
  for (const [scope, base] of scopes) {
    for (const file of listDir(path.join(base, "commands")).filter((f) => f.endsWith(".md"))) {
      const full = path.join(base, "commands", file);
      const [meta, body] = splitFrontmatter(readText(full));
      found.push(new Entry(file.slice(0, -3), "command", scope, full, meta, body));
    }
    for (const dir of listDir(path.join(base, "skills"))) {
      const full = path.join(base, "skills", dir, "SKILL.md");
      if (!existsSync(full) || !statSync(full).isFile()) continue;
      const [meta, body] = splitFrontmatter(readText(full));
      found.push(new Entry(String(meta.name ?? dir), "skill", scope, full, meta, body));
    }
  }
  return found;
}

// Higher rank wins a name collision. Skills: enterprise > personal > project; a skill beats a command.
// Two COMMANDS with the same name in personal and project scope: precedence is not documented.
const rank = (e: Entry): number => (e.kind === "skill" ? (e.scope === "personal" ? 3 : 2) : 1);

export interface Slot {
  name: string;
  winner: Entry;
  shadowed: Entry[];
  note: string;
}

/** What each /name actually runs for this developer, and what it hides. */
export function resolveNames(entries: Entry[]): Record<string, Slot> {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) groups.set(e.name, [...(groups.get(e.name) ?? []), e]);
  const slots: Record<string, Slot> = {};
  for (const name of [...groups.keys()].sort()) {
    const ranked = [...(groups.get(name) ?? [])].sort((a, b) => rank(b) - rank(a));
    const [winner, ...rest] = ranked;
    const notes = rest.map((loser) => {
      if (rank(loser) === rank(winner)) return "AMBIGUOUS: personal and project command share this name (undocumented precedence) - rename one";
      if (loser.kind === "command" && winner.kind === "skill") return `${loser.scope} command shadowed: a skill beats a command with the same name`;
      return `${loser.scope} skill shadowed: a personal skill beats a project skill with the same name`;
    });
    slots[name] = { name, winner, shadowed: rest, note: notes.join("; ") };
  }
  return slots;
}

/** [errors, warnings] for one command or skill file. */
export function validate(entry: Entry, projectRoot: string): [string[], string[]] {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed = entry.kind === "skill" ? SKILL_FIELDS : COMMAND_FIELDS;
  for (const key of Object.keys(entry.meta)) {
    if (key === "tools") warnings.push("unknown field 'tools' (that is the subagent-file field; skills use allowed-tools)");
    else if (!SKILL_FIELDS.has(key)) warnings.push(`unknown field '${key}' is ignored`);
    else if (!allowed.has(key)) warnings.push(`'${key}' only applies to skills, not commands`);
  }
  if (!entry.meta.description) warnings.push("no description: Claude cannot tell when the skill is relevant");
  if (entry.kind === "skill" && (!NAME_RE.test(entry.name) || entry.name.length > 64)) {
    errors.push(`name '${entry.name}' must be lowercase letters, digits and hyphens (max 64)`);
  }
  const context = entry.meta.context;
  if (context !== undefined && context !== "fork") errors.push(`context: '${String(context)}' is invalid; the only value is 'fork'`);
  const agent = entry.meta.agent === undefined ? "" : String(entry.meta.agent);
  if (agent && context !== "fork") warnings.push("agent is ignored unless context: fork is set");
  if (agent && !BUILT_IN_AGENTS.has(agent) && !existsSync(path.join(projectRoot, ".claude", "agents", `${agent}.md`))) {
    errors.push(`agent '${agent}' is not built-in (Explore, Plan, general-purpose) or in .claude/agents/`);
  }
  for (const tool of entry.allowedTools) {
    const match = TOOL_RE.exec(tool);
    if (!match || (!KNOWN_TOOLS.has(match[1]) && !match[1].startsWith("mcp__"))) warnings.push(`allowed-tools entry '${tool}' is not a known tool`);
  }
  for (const flag of ["disable-model-invocation", "user-invocable"]) {
    if (flag in entry.meta && typeof entry.meta[flag] !== "boolean") errors.push(`${flag} must be true or false`);
  }
  const hint = String(entry.meta["argument-hint"] ?? "");
  if (entry.requiredArgs && !hint) warnings.push(`needs ${entry.requiredArgs} argument(s) but has no argument-hint to tell people what to pass`);
  else if (hint && entry.requiredArgs > hintSlots(hint).length) {
    warnings.push(`argument-hint names ${hintSlots(hint).length} slot(s) but the body uses ${entry.requiredArgs}`);
  }
  return [errors, warnings];
}

// ---------------------------------------------------------------------------
// Permissions: allowed-tools PRE-APPROVES tools; deny rules and the agent's tool set restrict them
// ---------------------------------------------------------------------------

export interface Settings {
  permissions?: { allow?: string[]; deny?: string[] };
}

export function loadSettings(projectRoot: string): Settings {
  const file = path.join(projectRoot, ".claude", "settings.json");
  return existsSync(file) ? (JSON.parse(readText(file)) as Settings) : {};
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `Bash(git diff *)` matches the call `Bash(git diff main...HEAD)`; a bare `Write` matches any Write. */
export function ruleMatches(rule: string, call: string): boolean {
  const r = TOOL_RE.exec(rule);
  const c = TOOL_RE.exec(call);
  if (!r || !c || r[1] !== c[1]) return false;
  if (r[2] === undefined) return true;
  return new RegExp(`^${r[2].split("*").map(escapeRe).join(".*")}$`).test(c[2] ?? "");
}

/** What happens when Claude tries `call` while this skill is active (deny rules are checked first). */
export function decidePermission(call: string, entry: Entry, settings: Settings): string {
  const tool = (TOOL_RE.exec(call) ?? /(\w+)/.exec(call) ?? ["", call])[1];
  if (entry.forked && READ_ONLY_AGENTS.has(entry.agent ?? "") && FILE_WRITE_TOOLS.has(tool)) {
    return `unavailable (the ${entry.agent} subagent has no write tools)`;
  }
  const perms = settings.permissions ?? {};
  if ((perms.deny ?? []).some((rule) => ruleMatches(rule, call))) return "deny (settings.json deny rule)";
  if (entry.allowedTools.some((rule) => ruleMatches(rule, call))) return "allow (pre-approved by allowed-tools)";
  if ((perms.allow ?? []).some((rule) => ruleMatches(rule, call))) return "allow (settings.json allow rule)";
  return "ask (not pre-approved, so Claude must ask you)";
}

// ---------------------------------------------------------------------------
// Argument rendering
// ---------------------------------------------------------------------------

export interface Rendered {
  prompt: string | null; // what Claude receives; null when the developer must supply more input
  askUser: string | null; // the argument-hint prompt shown instead
  args: string[];
  shellCommands: string[]; // !`cmd` lines Claude Code runs first; their output replaces the line
}

/** Offline stand-in for !`cmd` injection: canned output, nothing is executed. */
export function offlineShell(command: string): string {
  if (command.startsWith("git diff --stat")) return readText(path.join(FIXTURES, "git-diff-stat.txt")).replace(/\n+$/, "");
  return `[output of \`${command}\` goes here]`;
}

/** Shell-style quoting: "two words" is one argument. Unbalanced quotes (can't) fall back to spaces. */
export function splitArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  let inToken = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && (raw[i + 1] === '"' || raw[i + 1] === "\\")) current += raw[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === "\\" && i + 1 < raw.length) {
      current += raw[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) args.push(current);
      current = "";
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) return raw.split(/\s+/).filter(Boolean);
  if (inToken) args.push(current);
  return args;
}

/** Expand placeholders the way Claude Code does when you type `/name raw`. */
export function render(entry: Entry, raw: string, shell: (cmd: string) => string = offlineShell): Rendered {
  const args = splitArgs(raw);
  if (args.length < entry.requiredArgs) {
    const hint = String(entry.meta["argument-hint"] ?? "");
    return { prompt: null, askUser: `${entry.slash} needs ${entry.requiredArgs} argument(s). Usage: ${entry.slash} ${hint}`.trimEnd(), args, shellCommands: [] };
  }
  const names = [...entry.argumentNames].sort((a, b) => b.length - a.length);
  const alternatives = ["\\$ARGUMENTS\\[(?<idx>\\d+)\\]", "\\$ARGUMENTS(?!\\w)", "\\$(?<pos>\\d+)"];
  if (names.length) alternatives.push(`\\$(?<named>${names.map(escapeRe).join("|")})(?!\\w)`);
  const pattern = new RegExp(alternatives.join("|"), "g");
  let received = false;

  // One pass over the ORIGINAL text, so a value containing "$1" is never substituted again.
  const substitute = (...parts: unknown[]): string => {
    const groups = parts[parts.length - 1] as Record<string, string | undefined>;
    let index: number;
    if (groups.idx !== undefined || groups.pos !== undefined) {
      index = Number(groups.idx ?? groups.pos); // 0-based: $0 is the FIRST argument
    } else if (groups.named !== undefined) {
      index = entry.argumentNames.indexOf(groups.named);
    } else {
      received = received || args.length > 0;
      return raw.trim();
    }
    if (index < args.length) {
      received = true;
      return args[index];
    }
    return ""; // a placeholder with no argument at its position expands to an empty string
  };

  let text = entry.body.split("\\$").join(ESCAPED_DOLLAR).replace(pattern, substitute);
  // Documented fallback: arguments no placeholder received are appended, so they are never lost.
  if (args.length && !received) text = `${text.replace(/\n+$/, "")}\n\nARGUMENTS: ${raw.trim()}\n`;
  const shellCommands = [...text.matchAll(SHELL_RE)].map((m) => m[1]);
  text = text.replace(SHELL_RE, (_m: string, cmd: string) => shell(cmd)).split(ESCAPED_DOLLAR).join("$");
  return { prompt: text, askUser: null, args, shellCommands };
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

/** A throwaway copy of the example repo + personal home under .lab-runtime/ (rebuilt every run). */
export function freshCopy(name: string): [string, string] {
  const base = path.join(RUNTIME, `${name}-ts`);
  rmSync(base, { recursive: true, force: true });
  cpSync(EXAMPLE_REPO, path.join(base, "repo"), { recursive: true });
  cpSync(USER_HOME, path.join(base, "home"), { recursive: true });
  return [path.join(base, "repo"), path.join(base, "home")];
}

function table(entries: Entry[]): string {
  const rows = [`  ${"/name".padEnd(26)}${"kind".padEnd(9)}${"scope".padEnd(10)}${"runs".padEnd(27)}${"pre-approved tools".padEnd(50)}invoked by`];
  for (const e of entries) {
    const runs = e.forked ? `forked -> ${e.agent}` : "inline (main context)";
    rows.push(`  ${e.slash.padEnd(26)}${e.kind.padEnd(9)}${e.scope.padEnd(10)}${runs.padEnd(27)}${(e.allowedTools.join(" ") || "-").padEnd(50)}${e.invocation}`);
  }
  return rows.join("\n");
}

const BROKEN_SKILL = `---
name: Summarize_Module
context: forked
agent: Explorer
tools: Read Grep
---
Summarize the module $1 for a newcomer.
`;

const LEGACY_COMMAND = `---
description: (legacy) codebase analysis, kept from before the skill existed
---
Analyze $ARGUMENTS and summarize it.
`;

const NAIVE_PERSONAL_REVIEW = `---
name: review
description: My tweaked copy of the team review
---
Review the current branch. Be extra strict about naming.
`;

function main(): void {
  lab.banner("D3.2  Skill and command inspector: scopes, frontmatter, collisions, forking");

  lab.section("1. What the lead developer sees (project + personal)");
  const entries = discover(EXAMPLE_REPO, USER_HOME);
  console.log(table(entries));
  const byName = new Map(entries.map((e) => [e.name, e] as [string, Entry]));
  const get = (name: string): Entry => {
    const e = byName.get(name);
    if (!e) throw new Error(`missing ${name}`);
    return e;
  };
  lab.check(get("review").kind === "command" && get("review").scope === "project", "/review is a project command (.claude/commands/), shared via git");
  lab.check(get("my-standup").scope === "personal" && get("review-strict").scope === "personal", "my-standup and review-strict are personal (~/.claude/): only this developer has them");
  const teammate = new Set(discover(EXAMPLE_REPO, null).map((e) => e.name));
  lab.check(
    ["review", "codebase-analysis", "scaffold-component", "brainstorm-alternatives"].every((n) => teammate.has(n)) && !teammate.has("my-standup"),
    "a teammate with an empty home gets every project entry and no personal ones",
  );

  lab.section("2. Frontmatter validation of the committed samples");
  let clean = true;
  for (const e of entries) {
    const [errors, warnings] = validate(e, EXAMPLE_REPO);
    clean = clean && !errors.length && !warnings.length;
    console.log(`  ${e.slash.padEnd(26)}${errors.length || warnings.length ? JSON.stringify([...errors, ...warnings]) : "OK"}`);
  }
  lab.check(clean, "all committed commands and skills validate cleanly");

  lab.section("3. Validation catches a broken skill (generated under .lab-runtime/)");
  let [repo, home] = freshCopy("broken");
  writeTree(repo, { ".claude/skills/summarize-module/SKILL.md": BROKEN_SKILL });
  const broken = discover(repo, home).find((e) => path.basename(path.dirname(e.file)) === "summarize-module");
  if (!broken) throw new Error("broken skill not discovered");
  const [errors, warnings] = validate(broken, repo);
  for (const line of errors) console.log(`  ERROR    ${line}`);
  for (const line of warnings) console.log(`  WARNING  ${line}`);
  lab.check(errors.length === 3, "bad name, context: forked (must be 'fork') and unknown agent 'Explorer' are errors");
  lab.check(warnings.some((w) => w.includes("'tools'")) && warnings.some((w) => w.includes("argument-hint")), "'tools' instead of allowed-tools, and $1 with no argument-hint, are flagged");

  lab.section("4. Name collisions");
  [repo, home] = freshCopy("collisions");
  writeTree(repo, { ".claude/commands/codebase-analysis.md": LEGACY_COMMAND });
  writeTree(home, { ".claude/skills/review/SKILL.md": NAIVE_PERSONAL_REVIEW });
  const lead = resolveNames(discover(repo, home));
  const mate = resolveNames(discover(repo, null));
  for (const name of ["codebase-analysis", "review"]) {
    const slot = lead[name];
    console.log(`  lead     /${name.padEnd(20)} -> ${slot.winner.kind} (${slot.winner.scope})   ${slot.note}`);
    console.log(`  teammate /${name.padEnd(20)} -> ${mate[name].winner.kind} (${mate[name].winner.scope})`);
  }
  lab.check(lead["codebase-analysis"].winner.kind === "skill", "a skill beats a leftover command with the same name");
  lab.check(lead.review.winner.scope === "personal", "a personal skill named 'review' silently shadows the team /review - for the lead");
  lab.check(mate.review.winner.scope === "project", "teammates are unaffected, but the lead no longer gets team checklist updates");
  const committed = resolveNames(entries);
  lab.check(
    committed.review.winner.scope === "project" && "review-strict" in committed,
    "the right way: a personal variant with a DIFFERENT name (/review-strict) keeps both available",
  );

  lab.section("5. Forked execution and tool access");
  const settings = loadSettings(EXAMPLE_REPO);
  const calls = ["Read(src/components/Button.tsx)", "Write(src/components/Button.tsx)", "Bash(pnpm add left-pad)", "Bash(rm -rf src)"];
  for (const name of ["codebase-analysis", "scaffold-component"]) {
    const e = get(name);
    console.log(`  /${name}  (${e.forked ? `forked -> ${e.agent}` : "inline"}, allowed-tools: ${e.allowedTools.join(" ")})`);
    for (const call of calls) console.log(`      ${call.padEnd(36)} ${decidePermission(call, e, settings)}`);
  }
  const forked = entries.filter((e) => e.forked).map((e) => e.name).sort();
  lab.check(JSON.stringify(forked) === '["brainstorm-alternatives","codebase-analysis"]', "verbose analysis and exploratory brainstorming run forked (context: fork)");
  lab.check(get("codebase-analysis").agent === "Explore" && get("brainstorm-alternatives").agent === "general-purpose", "agent: Explore for codebase-analysis; brainstorm uses the default general-purpose agent");
  const scaffold = get("scaffold-component");
  lab.check(decidePermission("Write(src/components/Button.tsx)", scaffold, settings).startsWith("allow"), "scaffold-component's Write is pre-approved by allowed-tools: Read Write");
  lab.check(decidePermission("Bash(rm -rf src)", scaffold, settings).startsWith("deny"), "a destructive command is blocked by the settings.json deny rule");
  lab.check(decidePermission("Bash(pnpm add left-pad)", scaffold, settings).startsWith("ask"), "allowed-tools does not hide Bash: an unlisted tool still prompts");
  lab.check(decidePermission("Write(x.ts)", get("codebase-analysis"), settings).startsWith("unavailable"), "the Explore agent behind a forked skill cannot write at all");
}

if (lab.isMain(import.meta.url)) main();
