/**
 * D3.2 - What Claude actually receives when you type `/name args`.
 *
 *   $ARGUMENTS       everything you typed after the name
 *   $ARGUMENTS[N]    the N-th argument, 0-based
 *   $0, $1, ...      shorthand for $ARGUMENTS[0], $ARGUMENTS[1] (0-BASED: $0 is the first argument)
 *   $issue           a named argument, declared with `arguments: [issue, branch]`
 *   \$5              a literal dollar sign
 *   !`git diff ...`  shell injection: Claude Code runs the command first and pastes its output
 *
 * Run:  npx tsx invokeSkill.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { EXAMPLE_REPO, USER_HOME, discover, freshCopy, render, resolveNames, writeTree, type Entry } from "./skillInspector.ts";

const FIX_ISSUE = `---
name: fix-issue
description: Fix a tracked issue on a given branch
argument-hint: "[issue-number] [branch]"
arguments: [issue, branch]
---
Fix issue #$issue on branch \`$branch\`.
Same values by position: $ARGUMENTS[0] / $1 (0-based, so $1 is the SECOND argument).
Escaped dollar stays literal: the fix must not change the \\$5 shipping fee.
`;

const EXPLAIN_ERROR = `---
name: explain-error
description: Explain an error message and the most likely cause in this codebase
---
Explain the error below in plain language, then point to the most likely cause in this repository.
`;

function showInvocation(entry: Entry, raw: string): void {
  const result = render(entry, raw);
  console.log(`\n> ${entry.slash} ${raw}`.trimEnd());
  if (result.prompt === null) {
    console.log(`  (not sent to Claude) ${result.askUser}`);
    return;
  }
  console.log(`  args: ${JSON.stringify(result.args)}`);
  if (result.shellCommands.length) console.log(`  shell injection ran first: ${JSON.stringify(result.shellCommands)}`);
  console.log("  prompt Claude receives:");
  console.log(result.prompt.trim().split("\n").map((line) => `    | ${line}`).join("\n"));
}

lab.banner("D3.2  Invoking commands and skills: argument substitution and argument-hint");
const slots = resolveNames(discover(EXAMPLE_REPO, USER_HOME));
const scaffold = slots["scaffold-component"].winner;
const review = slots.review.winner;

lab.section("1. Positional arguments are 0-based");
showInvocation(scaffold, "CartSummary src/components");
const full = render(scaffold, "CartSummary src/components").prompt ?? "";
lab.check(full.includes("Create the React component `CartSummary` in `src/components`"), "$0 -> first argument, $1 -> second argument");
lab.check(full.includes("interface CartSummaryProps"), "$0Props expands to CartSummaryProps (placeholder followed by text)");
lab.check(!full.includes("$0") && !full.includes("$1"), "no placeholder left unexpanded");

lab.section("2. argument-hint prompts for missing required arguments");
showInvocation(scaffold, "");
showInvocation(scaffold, "CartSummary");
const noneGiven = render(scaffold, "");
const oneGiven = render(scaffold, "CartSummary");
lab.check(noneGiven.prompt === null && String(noneGiven.askUser).includes("[ComponentName] [directory]"), "no arguments -> the developer sees the hint instead of a half-empty prompt");
lab.check(oneGiven.prompt === null, "one of two required arguments -> still asks");

lab.section("3. $ARGUMENTS plus !`shell` injection (/review)");
showInvocation(review, "security of the new cart endpoint");
const focused = render(review, "security of the new cart endpoint");
const focusedPrompt = focused.prompt ?? "";
lab.check(JSON.stringify(focused.shellCommands) === '["git diff --stat main...HEAD"]', "the !`git diff --stat main...HEAD` line is a shell injection");
lab.check(focusedPrompt.includes("3 files changed") && !focusedPrompt.includes("!`"), "its output replaces the line before Claude sees the prompt");
lab.check(focusedPrompt.includes("security of the new cart endpoint"), "$ARGUMENTS carries the whole focus phrase");
lab.check(render(review, "").prompt !== null, "the focus is optional ('[optional focus ...]'), so bare /review still runs");

lab.section("4. Named arguments, $ARGUMENTS[N], quoting and \\$ (generated skills)");
const [repo, home] = freshCopy("invoke");
writeTree(repo, { ".claude/skills/fix-issue/SKILL.md": FIX_ISSUE, ".claude/skills/explain-error/SKILL.md": EXPLAIN_ERROR });
const generated = resolveNames(discover(repo, home));
const fix = generated["fix-issue"].winner;
showInvocation(fix, '1234 "feat/cart totals"');
const named = render(fix, '1234 "feat/cart totals"');
const namedPrompt = named.prompt ?? "";
lab.check(JSON.stringify(named.args) === '["1234","feat/cart totals"]', 'shell-style quoting: "feat/cart totals" is ONE argument');
lab.check(namedPrompt.includes("Fix issue #1234 on branch `feat/cart totals`"), "named arguments: $issue and $branch");
lab.check(namedPrompt.includes("1234 / feat/cart totals"), "$ARGUMENTS[0] and $1 index the same 0-based list");
lab.check(!namedPrompt.includes("\\$5") && namedPrompt.includes("$5 shipping fee"), "\\$5 renders as a literal $5");

lab.section("5. Arguments are never dropped");
const explain = generated["explain-error"].winner;
const errorText = "TypeError: cannot read properties of undefined (reading 'total')";
showInvocation(explain, errorText);
const appended = render(explain, errorText).prompt ?? "";
lab.check(appended.trimEnd().endsWith(`ARGUMENTS: ${errorText}`), "no placeholder in the body -> 'ARGUMENTS: <input>' is appended");
