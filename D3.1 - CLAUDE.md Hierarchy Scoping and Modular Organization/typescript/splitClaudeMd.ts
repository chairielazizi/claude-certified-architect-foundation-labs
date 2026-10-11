/**
 * D3.1 - Split a monolithic CLAUDE.md into focused topic files under .claude/rules/.
 *
 * Rules WITHOUT `paths:` frontmatter still load at launch, exactly like CLAUDE.md, so this split
 * changes organization (ownership, reviewable diffs), not what Claude sees. Making a rule conditional
 * with `paths:` is what saves tokens; see D3.3.
 *
 * Run:  npx tsx splitClaudeMd.ts
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { EXAMPLE_REPO, LAB, RUNTIME, readText, resolveMemory, writeTree } from "./memoryResolver.ts";

const MONOLITH = path.join(LAB, "fixtures", "CLAUDE.monolithic.md");
// Which `## heading` goes to which rule file. The maintainer decides the topics; the tool just moves text.
const TOPIC_FILES: Record<string, string> = { Testing: "testing.md", "API conventions": "api-conventions.md", Deployment: "deployment.md" };

/** Move each `## <topic>` section into its own rule file; everything else stays in CLAUDE.md. */
function splitByHeadings(text: string, topics: Record<string, string>): [string, Record<string, string>] {
  const keep: string[] = [];
  const rules: Record<string, string> = {};
  for (const section of text.split(/^(?=## )/m)) {
    const heading = /^## (.+)\n/.exec(section);
    const title = heading ? heading[1].trim() : "";
    if (heading && title in topics) {
      rules[topics[title]] = `# ${title}\n\n${section.slice(heading[0].length).trim()}\n`;
    } else {
      keep.push(section);
    }
  }
  const pointer = Object.keys(rules).map((name) => `\`${name}\``).join(", ");
  const remaining = `${keep.join("").trimEnd()}\n\nTopic rules live in \`.claude/rules/\`: ${pointer}.\n`;
  return [remaining, rules];
}

const normalized = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

/** Every non-heading, non-blank line: the actual instructions that must survive the split. */
const instructionLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.trim());

lab.banner("D3.1  Split a monolithic CLAUDE.md into .claude/rules/ topic files");
const monolith = readText(MONOLITH);
const [remaining, rules] = splitByHeadings(monolith, TOPIC_FILES);

const files: Record<string, string> = { "home/.keep": "", "repo/CLAUDE.md": remaining };
for (const [name, body] of Object.entries(rules)) files[`repo/.claude/rules/${name}`] = body;
const out = writeTree(path.join(RUNTIME, "split-ts"), files);

lab.section("Before / after");
console.log(`  before: CLAUDE.md                ${String(monolith.split("\n").length - 1).padStart(3)} lines (one file, no owners)`);
console.log(`  after:  CLAUDE.md                ${String(remaining.split("\n").length - 1).padStart(3)} lines`);
for (const [name, body] of Object.entries(rules)) {
  console.log(`          .claude/rules/${name.padEnd(18)}${String(body.split("\n").length - 1).padStart(3)} lines`);
}

lab.section("What Claude loads after the split");
const splitRes = resolveMemory(path.join(out, "home"), path.join(out, "repo"));
console.log(splitRes.listing());

lab.check(
  JSON.stringify(Object.keys(rules).sort()) === JSON.stringify(Object.values(TOPIC_FILES).sort()),
  "testing.md, api-conventions.md, deployment.md were created",
);
const loaded = splitRes.allText();
lab.check(
  instructionLines(monolith).every((line) => loaded.includes(line)),
  "every instruction line from the monolith still loads at launch (nothing lost)",
);
const rulesDir = path.join(EXAMPLE_REPO, ".claude", "rules");
const committed: Record<string, string> = {};
for (const name of readdirSync(rulesDir).filter((n) => n.endsWith(".md"))) committed[name] = readText(path.join(rulesDir, name));
lab.check(
  Object.entries(rules).every(([name, body]) => normalized(body) === normalized(committed[name] ?? "")),
  "the split output matches example-repo/.claude/rules/ exactly (that layout IS this split)",
);
const beforeTokens = Math.floor(monolith.length / 4);
const afterTokens = splitRes.totalTokens();
console.log(`\n  tokens at launch: monolith ~${beforeTokens}, split ~${afterTokens}`);
lab.check(
  Math.abs(afterTokens - beforeTokens) <= beforeTokens * 0.1,
  "rules without paths load at launch too: splitting reorganizes, it does not save tokens (D3.3 does)",
);
