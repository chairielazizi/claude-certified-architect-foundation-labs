/**
 * D3.1 - Simulate which memory files Claude Code loads, in what order, and why.
 *
 *   user     ~/.claude/CLAUDE.md, ~/.claude/rules/*.md    only you, every project, NOT in git
 *   project  CLAUDE.md or .claude/CLAUDE.md in the launch  the whole team, via git
 *            directory and every ancestor directory
 *   local    CLAUDE.local.md                              only you, this checkout, gitignored
 *   rule     .claude/rules/**\/*.md without `paths:`       the team, loaded at launch like CLAUDE.md
 *   subdir   CLAUDE.md files BELOW the launch directory    loaded ON DEMAND, when Claude touches a file there
 *
 * `@path` imports are inlined (relative to the importing file, at most 4 hops, never inside code).
 * The simulated filesystem boundary is the repo root (real Claude Code keeps walking up to /).
 *
 * Run:  npx tsx memoryResolver.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as lab from "../../shared/typescript/labkit.ts";

export const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLE_REPO = path.join(LAB, "example-repo");
export const LEAD_HOME = path.join(LAB, "user-home-example");
export const TEAMMATE_HOME = path.join(LAB, "user-home-teammate");
export const RUNTIME = path.join(LAB, ".lab-runtime");

// Documented limit: imported files can import further files, up to four hops deep.
export const MAX_IMPORT_DEPTH = 4;

// `@path` only when the @ starts a token: "platform@acme.example" (an email) is not an import.
const IMPORT_RE = /(?<![\w@`])@((?:~\/|\.\.?\/|\/)?[\w.\-]+(?:\/[\w.\-]+)*)/g;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`+).+?\1/g;

/** Read a text file with normalized line endings (a Windows checkout may have CRLF). */
export function readText(file: string): string {
  return readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
}

export function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

export function isRelativeTo(child: string, base: string): boolean {
  const rel = path.relative(base, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** Rough token estimate (chars / 4) - good enough to compare configurations. */
export function tokens(text: string): number {
  return text ? Math.max(1, Math.floor(text.length / 4)) : 0;
}

/** Return [YAML frontmatter as an object, body]. Files without frontmatter return [{}, text]. */
export function splitFrontmatter(text: string): [Record<string, unknown>, string] {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const meta: unknown = parseYaml(text.slice(3, end)) ?? {};
      const body = text.slice(end + 4).replace(/^\n+/, "");
      const isObject = meta !== null && typeof meta === "object" && !Array.isArray(meta);
      return [isObject ? (meta as Record<string, unknown>) : {}, body];
    }
  }
  return [{}, text];
}

/** Blank out fenced code blocks and inline code spans, because imports are not parsed there. */
export function stripCode(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const match = FENCE_RE.exec(line);
    if (match && (fence === null || line.trim().startsWith(fence))) {
      fence = fence === null ? match[1][0].repeat(3) : null;
      out.push("");
      continue;
    }
    out.push(fence ? "" : line.replace(INLINE_CODE_RE, ""));
  }
  return out.join("\n");
}

/** The `@path` imports in a memory file, in document order, ignoring code. */
export function findImports(text: string): string[] {
  const [, body] = splitFrontmatter(text);
  return [...stripCode(body).matchAll(IMPORT_RE)].map((m) => m[1].replace(/[.,;:]+$/, ""));
}

export interface MemoryFile {
  path: string;
  scope: string; // user | project | local | rule | subdir (imports inherit their parent's scope)
  loaded: string; // launch | import | on demand
  reason: string;
  text: string;
  depth: number; // import hops from the top-level memory file
}

export class Resolution {
  files: MemoryFile[] = [];
  skipped: Array<[string, string]> = []; // [what, why it did not load]

  constructor(
    readonly userHome: string,
    readonly repoRoot: string,
    readonly cwd: string,
  ) {}

  /** Paths the way a developer reads them: ~/... for the home dir, ./... for the repo. */
  display(file: string): string {
    const bases: Array<[string, string]> = [
      [this.repoRoot, "./"],
      [this.userHome, "~/"],
    ];
    for (const [base, prefix] of bases) {
      if (isRelativeTo(file, base)) return prefix + toPosix(path.relative(base, file));
    }
    return toPosix(file);
  }

  find(needle: string): MemoryFile[] {
    return this.files.filter((f) => f.text.toLowerCase().includes(needle.toLowerCase()));
  }

  loaded(rel: string): MemoryFile | undefined {
    return this.files.find((f) => this.display(f.path) === rel);
  }

  allText(): string {
    return this.files.map((f) => f.text).join("\n");
  }

  totalTokens(): number {
    return this.files.reduce((sum, f) => sum + tokens(f.text), 0);
  }

  /** A /memory-style listing: load order, scope, how each file got there, token estimate. */
  listing(): string {
    const rows = this.files.map((f, i) => {
      const name = "    ".repeat(f.depth) + (f.depth ? "@-> " : "") + this.display(f.path);
      const how = f.depth ? `import (${f.depth} hop${f.depth > 1 ? "s" : ""})` : f.loaded;
      const estimate = `~${tokens(f.text)}`;
      return `  ${String(i + 1).padStart(2)}  ${f.scope.padEnd(8)}${name.padEnd(46)} ${how.padEnd(16)}${estimate.padStart(5)} tok  ${f.reason}`;
    });
    rows.push(`      total at this point: ~${this.totalTokens()} tokens`);
    for (const [what, why] of this.skipped) rows.push(`      not loaded: ${what}  (${why})`);
    return rows.join("\n");
  }
}

function ruleFiles(rulesDir: string): string[] {
  if (!existsSync(rulesDir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(rulesDir, { withFileTypes: true })) {
    const full = path.join(rulesDir, entry.name);
    if (entry.isDirectory()) found.push(...ruleFiles(full));
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found.sort();
}

/** Directories from the boundary down to cwd (outermost first): broad context loads first. */
function ancestorsFromRoot(cwd: string, boundary: string): string[] {
  const chain = [cwd];
  while (chain[chain.length - 1] !== boundary && isRelativeTo(chain[chain.length - 1], boundary)) {
    const parent = path.dirname(chain[chain.length - 1]);
    if (parent === chain[chain.length - 1]) break;
    chain.push(parent);
  }
  return chain.reverse();
}

/** Directories strictly below cwd down to `directory` (outermost first); [] if outside cwd. */
function dirsBelow(cwd: string, directory: string): string[] {
  if (directory === cwd || !isRelativeTo(directory, cwd)) return [];
  const parts = path.relative(cwd, directory).split(path.sep);
  return parts.map((_, i) => path.join(cwd, ...parts.slice(0, i + 1)));
}

/** Imports resolve relative to the IMPORTING file (not the cwd); ~/ means the user's home. */
function resolveImport(raw: string, baseDir: string, userHome: string): string {
  if (raw.startsWith("~/")) return path.resolve(userHome, raw.slice(2));
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw);
}

class Loader {
  private seen = new Set<string>();
  constructor(private res: Resolution) {}

  load(file: string, scope: string, loaded: string, reason: string): void {
    if (!isFile(file) || this.seen.has(file)) return;
    const entry: MemoryFile = { path: file, scope, loaded, reason, text: readText(file), depth: 0 };
    this.seen.add(file);
    this.res.files.push(entry);
    this.expand(entry, [file]);
  }

  loadRules(rulesDir: string, scope: string): void {
    for (const rule of ruleFiles(rulesDir)) {
      const [meta] = splitFrontmatter(readText(rule));
      if (meta.paths) {
        // Path-scoped rules wait until Claude touches a matching file - that is D3.3's topic.
        this.res.skipped.push([this.res.display(rule), "path-scoped rule; loads when a matching file is touched"]);
        continue;
      }
      this.load(rule, scope, "launch", "rule without paths: always loaded");
    }
  }

  /** Inline @imports depth-first, so each import sits right after the file that pulled it in. */
  private expand(parent: MemoryFile, chain: string[]): void {
    for (const raw of findImports(parent.text)) {
      const target = resolveImport(raw, path.dirname(parent.path), this.res.userHome);
      const what = `@${raw} in ${this.res.display(parent.path)}`;
      if (chain.includes(target)) {
        const cycle = [...chain, target].map((p) => this.res.display(p)).join(" -> ");
        this.res.skipped.push([what, `import cycle ${cycle}`]);
      } else if (!isFile(target)) {
        this.res.skipped.push([what, "no such file; left as plain text"]);
      } else if (this.seen.has(target)) {
        this.res.skipped.push([what, "already loaded earlier; listed once"]);
      } else if (parent.depth + 1 > MAX_IMPORT_DEPTH) {
        this.res.skipped.push([what, `deeper than the ${MAX_IMPORT_DEPTH}-hop import limit`]);
      } else {
        const child: MemoryFile = {
          path: target,
          scope: parent.scope,
          loaded: "import",
          reason: `imported by ${this.res.display(parent.path)}`,
          text: readText(target),
          depth: parent.depth + 1,
        };
        this.seen.add(target);
        this.res.files.push(child);
        this.expand(child, [...chain, target]);
      }
    }
  }
}

/**
 * Compute the memory files one developer's session has loaded. Files are listed broadest first;
 * all are concatenated into context (nothing overrides anything), so fix contradictions in the files.
 */
export function resolveMemory(userHome: string, repoRoot: string, cwd?: string, filesRead: string[] = []): Resolution {
  const home = path.resolve(userHome);
  const root = path.resolve(repoRoot);
  const launch = path.resolve(cwd ?? root);
  const res = new Resolution(home, root, launch);
  const loader = new Loader(res);

  // 1. User scope: applies to every project, but lives only on this developer's machine.
  loader.load(path.join(home, ".claude", "CLAUDE.md"), "user", "launch", "user memory: only you, every project");
  loader.loadRules(path.join(home, ".claude", "rules"), "user");

  // 2. Launch directory and its ancestors, broadest first.
  for (const dir of ancestorsFromRoot(launch, root)) {
    const where = dir === launch ? "launch dir" : "ancestor of launch dir";
    loader.load(path.join(dir, "CLAUDE.md"), "project", "launch", `project memory (${where})`);
    loader.load(path.join(dir, ".claude", "CLAUDE.md"), "project", "launch", `project memory (${where})`);
    loader.load(path.join(dir, "CLAUDE.local.md"), "local", "launch", "local memory: you, this checkout");
    // 3. Topic rules without `paths:` load at launch with the same priority as CLAUDE.md.
    if (dir === root) loader.loadRules(path.join(root, ".claude", "rules"), "rule");
  }

  // 4. CLAUDE.md / CLAUDE.local.md below the launch dir load once Claude touches a file there.
  for (const read of filesRead) {
    const target = path.resolve(root, read);
    for (const dir of dirsBelow(launch, path.dirname(target))) {
      const why = `on demand: Claude touched ${res.display(target)}`;
      loader.load(path.join(dir, "CLAUDE.md"), "subdir", "on demand", why);
      loader.load(path.join(dir, ".claude", "CLAUDE.md"), "subdir", "on demand", why);
      loader.load(path.join(dir, "CLAUDE.local.md"), "local", "on demand", why);
    }
  }
  return res;
}

/** Create a small directory tree from {relative path: content} (fresh each run). */
export function writeTree(root: string, files: Record<string, string>): string {
  rmSync(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  return root;
}

export const EDGE_CASE_TREE: Record<string, string> = {
  "home/.keep": "",
  "repo/CLAUDE.md":
    "# Import edge cases\n\n" +
    "Deep chain: @hops/hop1.md\n" +
    "Cycle: @cycle/a.md\n" +
    "Typo: @docs/does-not-exist.md\n" +
    "Email, not an import: page oncall@acme.example\n" +
    "Inline code is not parsed: `@hops/never.md`\n\n" +
    "```bash\n" +
    "pnpm add -D @types/node   # inside a fenced block: not an import\n" +
    "```\n",
  "repo/hops/hop1.md": "hop 1 -> @hop2.md\n",
  "repo/hops/hop2.md": "hop 2 -> @hop3.md\n",
  "repo/hops/hop3.md": "hop 3 -> @hop4.md\n",
  "repo/hops/hop4.md": "hop 4 -> @hop5.md\n",
  "repo/hops/hop5.md": "hop 5: one hop too deep\n",
  "repo/hops/never.md": "should never load\n",
  "repo/cycle/a.md": "a imports @b.md\n",
  "repo/cycle/b.md": "b imports @a.md\n",
};

function main(): void {
  lab.banner("D3.1  CLAUDE.md hierarchy: which memory files load, and when");

  lab.section("1. Lead developer launches `claude` at the repo root");
  let res = resolveMemory(LEAD_HOME, EXAMPLE_REPO);
  console.log(res.listing());
  lab.check(res.files[0].scope === "user", "user memory (~/.claude/CLAUDE.md) loads first: broadest scope");
  const root = res.loaded("./CLAUDE.md");
  const git = res.loaded("./docs/standards/git-workflow.md");
  lab.check(root !== undefined && root.loaded === "launch", "project CLAUDE.md loads at launch");
  lab.check(git !== undefined && git.depth === 1, "@docs/standards/git-workflow.md is inlined one hop deep");
  lab.check(res.files.filter((f) => f.scope === "rule").length === 3, ".claude/rules/*.md without paths (testing, api-conventions, deployment) load at launch");
  lab.check(!res.files.some((f) => f.scope === "subdir"), "no package CLAUDE.md yet: they load on demand");
  lab.check(
    res.loaded("./docs/standards/pci-dss.md") === undefined,
    "the backticked `@../../docs/standards/pci-dss.md` in the root CLAUDE.md is a mention, not an import",
  );

  lab.section("2. Same session, after Claude reads packages/payments/src/money.ts");
  res = resolveMemory(LEAD_HOME, EXAMPLE_REPO, undefined, ["packages/payments/src/money.ts"]);
  console.log(res.listing());
  const payments = res.loaded("./packages/payments/CLAUDE.md");
  const pci = res.loaded("./docs/standards/pci-dss.md");
  const logging = res.loaded("./docs/standards/logging.md");
  lab.check(payments !== undefined && payments.loaded === "on demand", "packages/payments/CLAUDE.md loaded on demand");
  lab.check(pci !== undefined && pci.depth === 1, "@../../docs/standards/pci-dss.md resolved relative to the importing file");
  lab.check(logging !== undefined && logging.depth === 2, "pci-dss.md's own @logging.md import resolved next to pci-dss.md (2 hops)");
  lab.check(res.loaded("./packages/web/CLAUDE.md") === undefined, "web conventions stay out of context: nothing in packages/web was read");

  lab.section("3. Launched from packages/web (cwd is a subdirectory)");
  res = resolveMemory(LEAD_HOME, EXAMPLE_REPO, path.join(EXAMPLE_REPO, "packages", "web"));
  console.log(res.listing());
  const web = res.loaded("./packages/web/CLAUDE.md");
  lab.check(web !== undefined && web.loaded === "launch", "the launch directory's CLAUDE.md loads at launch");
  lab.check(res.loaded("./CLAUDE.md") !== undefined, "ancestor CLAUDE.md (repo root) still loads: the walk goes up");
  lab.check(res.loaded("./docs/standards/react.md") !== undefined, "web's @../../docs/standards/react.md import is inlined");

  lab.section("4. Import edge cases (generated under .lab-runtime/)");
  const tree = writeTree(path.join(RUNTIME, "import-edge-cases-ts"), EDGE_CASE_TREE);
  res = resolveMemory(path.join(tree, "home"), path.join(tree, "repo"));
  console.log(res.listing());
  const reasons = res.skipped.map(([, why]) => why).join(" | ");
  const hop4 = res.loaded("./hops/hop4.md");
  lab.check(hop4 !== undefined && hop4.depth === 4, "a 4-hop import chain is followed to the end of the limit");
  lab.check(res.loaded("./hops/hop5.md") === undefined && reasons.includes("4-hop import limit"), "the 5th hop is not expanded");
  lab.check(reasons.includes("import cycle") && res.loaded("./cycle/b.md") !== undefined, "a <-> b cycle detected; each file loads once");
  lab.check(reasons.includes("no such file"), "a typo'd import is reported, not silently loaded");
  const found = findImports(EDGE_CASE_TREE["repo/CLAUDE.md"]);
  lab.check(
    !found.some((i) => i.startsWith("types") || i.startsWith("hops/never") || i.startsWith("acme")),
    "emails, inline code and fenced code blocks are never treated as imports",
  );
  console.log("\nIn Claude Code, run /memory to see the real list for your session.");
}

if (lab.isMain(import.meta.url)) main();
