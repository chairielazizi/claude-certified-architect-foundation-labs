/**
 * D3.2 - Skill (on demand) or CLAUDE.md (always loaded)? An explicit decision helper.
 *
 *   CLAUDE.md / .claude/rules   loaded into EVERY session -> universal standards
 *   skill / command             loaded only when invoked -> task-specific workflows
 *   + context: fork             verbose or exploratory output stays in a subagent
 *   + allowed-tools             pre-approve exactly the tools the workflow needs
 *   + disable-model-invocation  side effects -> only a human starts it
 *
 * Run:  npx tsx skillOrClaudeMd.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";

interface Guidance {
  text: string;
  appliesToEveryTask: boolean; // would you want Claude to follow it whatever the current task is?
  fileGlobs?: string[]; // only relevant for some files (-> path rule)
  verboseOrExploratory?: boolean; // lots of intermediate output the main session doesn't need
  sideEffects?: boolean; // writes files or runs commands
  readOnly?: boolean;
}

interface Decision {
  where: string;
  frontmatter: Record<string, unknown>;
  reasons: string[];
}

function decide(g: Guidance): Decision {
  if (g.appliesToEveryTask && g.fileGlobs?.length) {
    return {
      where: ".claude/rules/<topic>.md with paths:",
      frontmatter: { paths: g.fileGlobs },
      reasons: ["always applies, but only to some files: a path-scoped rule loads it exactly then (D3.3)"],
    };
  }
  if (g.appliesToEveryTask) {
    return { where: "CLAUDE.md", frontmatter: {}, reasons: ["universal standard: must be in context for every task, so always load it"] };
  }
  const reasons = ["task-specific workflow: load it only when someone runs it, not in every session"];
  const front: Record<string, unknown> = {};
  if (g.verboseOrExploratory) {
    front.context = "fork";
    reasons.push("verbose/exploratory output: context: fork keeps it out of the main conversation");
    if (g.readOnly) {
      front.agent = "Explore";
      reasons.push("read-only discovery: run it on the Explore subagent");
    }
  }
  if (g.readOnly) {
    front["allowed-tools"] = "Read Grep Glob";
  } else if (g.sideEffects) {
    front["allowed-tools"] = "Read Write";
    front["disable-model-invocation"] = true;
    reasons.push("side effects: pre-approve only what it needs, and let only a human trigger it");
  }
  return { where: ".claude/skills/<name>/SKILL.md", frontmatter: front, reasons };
}

const SKILL = ".claude/skills/<name>/SKILL.md";
const EXAMPLES: Array<[Guidance, string]> = [
  [{ text: "TypeScript strict mode everywhere; never use `any`", appliesToEveryTask: true }, "CLAUDE.md"],
  [{ text: "Use pnpm, never npm or yarn", appliesToEveryTask: true }, "CLAUDE.md"],
  [{ text: "Commit messages follow Conventional Commits", appliesToEveryTask: true }, "CLAUDE.md"],
  [
    { text: "Test files use node:test and query the DOM with getByRole", appliesToEveryTask: true, fileGlobs: ["**/*.test.tsx", "**/*.test.ts"] },
    ".claude/rules/<topic>.md with paths:",
  ],
  [{ text: "Run the team review checklist on the current branch", appliesToEveryTask: false, readOnly: true }, SKILL],
  [
    { text: "Map how the checkout module works before a refactor (reads dozens of files)", appliesToEveryTask: false, verboseOrExploratory: true, readOnly: true },
    SKILL,
  ],
  [{ text: "Compare three designs for persisting the cart", appliesToEveryTask: false, verboseOrExploratory: true }, SKILL],
  [{ text: "Scaffold a component with its test and CSS module", appliesToEveryTask: false, sideEffects: true }, SKILL],
];

lab.banner("D3.2  Skill or CLAUDE.md? Deciding where guidance belongs");
const decisions = EXAMPLES.map(([guidance, expected]) => ({ guidance, decision: decide(guidance), expected }));
for (const { guidance, decision } of decisions) {
  const extras = Object.keys(decision.frontmatter).length ? `  ${JSON.stringify(decision.frontmatter)}` : "";
  console.log(`\n  ${guidance.text}\n    -> ${decision.where}${extras}`);
  for (const reason of decision.reasons) console.log(`       - ${reason}`);
}

lab.section("Checks");
const byText = new Map(decisions.map((d) => [d.guidance.text, d.decision] as [string, Decision]));
const front = (text: string): Record<string, unknown> => byText.get(text)?.frontmatter ?? {};
lab.check(decisions.every((d) => d.decision.where === d.expected), "every example lands where the exam expects");
lab.check(front("Map how the checkout module works before a refactor (reads dozens of files)").context === "fork", "verbose codebase analysis -> skill with context: fork");
lab.check(front("Compare three designs for persisting the cart").context === "fork", "exploratory brainstorming -> skill with context: fork");
lab.check(front("Scaffold a component with its test and CSS module")["allowed-tools"] === "Read Write", "scaffolding -> allowed-tools limited to file read/write");
lab.check(byText.get("Use pnpm, never npm or yarn")?.where === "CLAUDE.md", "a convention every task must follow is never a skill: skills only load when invoked");
