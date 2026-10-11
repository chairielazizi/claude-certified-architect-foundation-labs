/**
 * D2.5 - Which built-in tool for which job, run against sample_repo/.
 *
 * The rule of thumb the exam tests:
 *   searching file CONTENTS (callers, error messages, imports)  -> Grep
 *   finding files by NAME / PATH pattern (** /*.test.tsx)        -> Glob
 *   loading a whole file to understand it                       -> Read
 *   changing one uniquely identifiable piece of a file          -> Edit
 *   creating a file, or replacing a whole file                  -> Write
 *   running something (tests, git, build)                       -> Bash
 *
 * pickBuiltin() encodes that rule; each Grep/Glob/Read task is then executed with the mini
 * tools so you can see why that tool fits.
 *
 * Always offline. Run:  npx tsx toolSelection.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";
import { Workspace, lines } from "./miniTools.ts";

const SAMPLE_REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample_repo");

// Ordered: the first rule whose pattern matches the task wins.
const RULES: [string, RegExp, string][] = [
  ["Bash", /\b(run|execute|install|git|build)\b/i, "executes commands"],
  ["Glob", /\b(files? (named|matching|ending)|file names?|by name|\*\*\/)/i, "matches file PATHS by pattern"],
  ["Grep", /\b(callers?|calls?|usages?|uses|where .* (raised|defined|logged)|imports?|error message|containing)\b/i, "searches file CONTENTS"],
  ["Write", /\b(create|new file|rewrite|replace the whole)\b/i, "creates / fully replaces a file"],
  ["Edit", /\b(change|rename|bump|fix)\b/i, "targeted change at a unique anchor"],
  ["Read", /\b(understand|read|review|explain)\b/i, "loads full contents"],
];

// [task, expected tool, how to run it in the sample repo or null]
const TASKS: [string, string, [string, string] | null][] = [
  ["Find all callers of charge()", "Grep", ["grep", "\\bcharge\\("]],
  ["Find test files matching **/*.test.tsx", "Glob", ["glob", "**/*.test.tsx"]],
  ["Find where the error message 'Refund window expired' is raised", "Grep", ["grep", "Refund window expired"]],
  ["Find Python test files named test_*.py anywhere", "Glob", ["glob", "**/test_*.py"]],
  ["Find every module that imports from app.payments", "Grep", ["grep", "from app\\.payments import"]],
  ["Understand the checkout flow in app/checkout.py", "Read", ["read", "app/checkout.py"]],
  ["Bump the refund window_days from 30 to 45", "Edit", null],
  ["Create a new file tests/test_reconcile.py", "Write", null],
  ["Run the test suite", "Bash", null],
];

function pickBuiltin(task: string): [string, string] {
  for (const [tool, pattern, why] of RULES) if (pattern.test(task)) return [tool, why];
  return ["Read", "default: look before acting"];
}

lab.banner("D2.5  Choosing between Read, Write, Edit, Bash, Grep and Glob");
const ws = new Workspace(SAMPLE_REPO);
console.log(`sample repo: ${ws.allFiles().length} files`);

lab.section("Tool selection table");
const choices: Record<string, string> = {};
for (const [task] of TASKS) {
  const [tool, why] = pickBuiltin(task);
  choices[task] = tool;
  console.log(`  ${task.padEnd(64)} -> ${tool.padEnd(5)} (${why})`);
}

lab.section("Running the Grep / Glob / Read tasks");
const outputs: Record<string, string[]> = {};
for (const [task, , action] of TASKS) {
  if (!action) continue;
  const [kind, arg] = action;
  let result: string[];
  if (kind === "grep") result = ws.grep(arg).map(([p, n]) => `${p}:${n}`);
  else if (kind === "glob") result = ws.glob(arg);
  else result = [`${lines(ws.read(arg)).length} lines of ${arg}`];
  outputs[task] = result;
  console.log(`  ${choices[task]} '${arg}': ${JSON.stringify(result)}`);
}

lab.section("Checks");
lab.check(TASKS.every(([t, e]) => choices[t] === e), "every task maps to the expected built-in tool");
const tsx = outputs["Find test files matching **/*.test.tsx"];
lab.check(tsx.length === 2 && new Set(tsx.map((p) => path.posix.dirname(p))).size === 2, "Glob finds *.test.tsx spread across directories (components/ and pages/)");
const pyTests = outputs["Find Python test files named test_*.py anywhere"];
lab.check(
  ["tests/test_checkout.py", "app/payments/test_stripe_adapter.py"].every((f) => pyTests.includes(f)),
  "Glob ** reaches test files next to the code and in tests/",
);
lab.check(outputs["Find where the error message 'Refund window expired' is raised"][0].startsWith("app/core.py"), "Grep locates the error message at its source (app/core.py)");
lab.check(outputs["Find all callers of charge()"].some((p) => p.startsWith("app/checkout.py")), "Grep finds the charge() call in checkout.py");
