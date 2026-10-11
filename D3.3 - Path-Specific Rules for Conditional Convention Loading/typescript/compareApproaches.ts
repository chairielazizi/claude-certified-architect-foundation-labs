/**
 * D3.3 - Three ways to deliver the same conventions, compared on the same repo.
 *
 *   A. monolithic CLAUDE.md   every convention in one file; all of it loads in every session
 *   B. path-scoped rules      general.md always + only the rules whose globs match touched files
 *   C. directory CLAUDE.md    a CLAUDE.md per directory; loads when Claude works in that directory
 *
 * Run:  npx tsx compareApproaches.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { globMatch } from "./globMatch.ts";
import { EXAMPLE_REPO, RUNTIME, SESSIONS, loadRules, repoFiles, rulesFor, tokens, type Rule } from "./ruleLoader.ts";

const TEST_MARKER = "# Test conventions"; // first heading of tests.md
const NEW_TEST_FILE = "src/hooks/useCart.test.ts"; // a test in a directory that did not exist when C was set up

/** Rule text without frontmatter (a monolithic or directory CLAUDE.md has no paths:). */
const body = (rule: Rule): string => `${rule.text.replace(/^---\n[\s\S]*?\n---\n/, "").trim()}\n`;

/** Leading path segments with no wildcard: "src/api/**\/*" -> "src/api"; "**\/*.test.ts" -> "". */
function staticPrefix(glob: string): string {
  const prefix: string[] = [];
  for (const segment of glob.split("/").slice(0, -1)) {
    if (/[*?[{]/.test(segment)) break;
    prefix.push(segment);
  }
  return prefix.join("/");
}

/** Drop directories nested inside another one (a CLAUDE.md there already covers the subtree). */
const topmost = (dirs: Set<string>): string[] =>
  [...dirs].filter((d) => ![...dirs].some((o) => d !== o && d.startsWith(`${o}/`))).sort();

/** Where each rule would have to live if conventions could only be attached to directories. */
function directoryLayout(rules: Rule[], files: string[]): Map<string, Rule[]> {
  const layout = new Map<string, Rule[]>([["", rules.filter((r) => !r.conditional)]]);
  for (const rule of rules.filter((r) => r.conditional)) {
    const homes = new Set<string>();
    for (const glob of rule.paths) {
      const prefix = staticPrefix(glob);
      if (prefix) {
        homes.add(prefix); // e.g. terraform/** has one natural home
      } else {
        // e.g. **/*.test.ts: every directory tree that has a matching file needs a copy
        const dirs = new Set(files.filter((f) => f.includes("/") && globMatch(glob, f)).map((f) => f.slice(0, f.lastIndexOf("/"))));
        for (const d of topmost(dirs)) homes.add(d);
      }
    }
    for (const home of topmost(homes)) layout.set(home, [...(layout.get(home) ?? []), rule]);
  }
  return layout;
}

/** Root CLAUDE.md + every directory CLAUDE.md between the root and each touched file. */
function loadDirectoryApproach(layout: Map<string, Rule[]>, touched: string[]): string {
  const dirs = new Set<string>([""]);
  for (const file of touched) {
    const parts = file.split("/").slice(0, -1);
    parts.forEach((_, i) => dirs.add(parts.slice(0, i + 1).join("/")));
  }
  return [...dirs]
    .sort()
    .flatMap((d) => layout.get(d) ?? [])
    .map(body)
    .join("");
}

lab.banner("D3.3  Monolithic CLAUDE.md vs path-scoped rules vs directory CLAUDE.md");
const rules = loadRules(EXAMPLE_REPO);
const files = repoFiles(EXAMPLE_REPO);
const monolith = rules.map(body).join("");
const layout = directoryLayout(rules, files);

const out = path.join(RUNTIME, "directory-claude-md-ts");
rmSync(out, { recursive: true, force: true });
for (const [dir, assigned] of layout) {
  const target = path.join(out, dir, "CLAUDE.md");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, assigned.map(body).join(""), "utf-8");
}

lab.section("Approach C needs these directory CLAUDE.md files");
for (const [dir, assigned] of [...layout].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${`${dir || "."}/CLAUDE.md`.padEnd(28)} ${assigned.map((r) => r.name).join(", ")}`);
}
const testCopies = [...layout].filter(([, assigned]) => assigned.some((r) => r.name === "tests.md")).map(([d]) => d);

lab.section("Tokens in context per editing session");
console.log(`  ${"session".padEnd(26)}${"A monolith".padStart(11)}${"B rules".padStart(9)}${"C dirs".padStart(8)}   test rules loaded? (B / C)`);
const rows: Array<[string, number, number, number]> = [];
for (const [title, [touched]] of Object.entries(SESSIONS)) {
  const bText = rulesFor(rules, touched).map((a) => body(a.rule)).join("");
  const cText = loadDirectoryApproach(layout, touched);
  rows.push([title, tokens(monolith), tokens(bText), tokens(cText)]);
  const isTest = touched.some((t) => t.endsWith(".test.ts") || t.endsWith(".test.tsx"));
  const flag = `${bText.includes(TEST_MARKER) ? "yes" : "no"} / ${cText.includes(TEST_MARKER) ? "yes" : "no"}`;
  console.log(
    `  ${title.padEnd(26)}${String(tokens(monolith)).padStart(11)}${String(tokens(bText)).padStart(9)}${String(tokens(cText)).padStart(8)}   ${flag}${isTest ? "" : "  (not a test file)"}`,
  );
}
const averageA = rows.reduce((s, r) => s + r[1], 0) / rows.length;
const averageB = rows.reduce((s, r) => s + r[2], 0) / rows.length;
console.log(`  ${"average".padEnd(26)}${averageA.toFixed(0).padStart(11)}${averageB.toFixed(0).padStart(9)}   -> path rules save ${Math.round((1 - averageB / averageA) * 100)}% vs the monolith`);

lab.section("Checks");
const ruleText = (touched: string[]) => rulesFor(rules, touched).map((a) => a.rule.text).join("");
lab.check(rows.every(([, a, b]) => b < a), "path-scoped rules load less than the monolith in every session");
lab.check(1 - averageB / averageA >= 0.4, "on average they cut convention tokens by at least 40%");
lab.check(
  JSON.stringify([...testCopies].sort()) === '["e2e","src/api","src/components","src/lib"]',
  `directory CLAUDE.md needs the test conventions copied into ${testCopies.length} places; tests.md is ONE file`,
);
const component = ["src/components/Button.tsx"];
lab.check(
  loadDirectoryApproach(layout, component).includes(TEST_MARKER) && !ruleText(component).includes(TEST_MARKER),
  "editing Button.tsx: directory CLAUDE.md drags in test rules anyway; the glob rule does not",
);
lab.check(
  ruleText([NEW_TEST_FILE]).includes(TEST_MARKER) && !loadDirectoryApproach(layout, [NEW_TEST_FILE]).includes(TEST_MARKER),
  `a new ${NEW_TEST_FILE}: **/*.test.ts covers it automatically; no directory CLAUDE.md exists there`,
);
