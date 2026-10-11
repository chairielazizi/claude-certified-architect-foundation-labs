/**
 * D3.5 - Test-driven iteration: write the tests first, then iterate by sharing the failures.
 *
 *   tests (expected behavior + null/missing edge cases + a performance requirement)  <- written FIRST
 *   loop (bounded): Claude writes / revises the module -> run the tests in a SUBPROCESS with a
 *   timeout (never import model code in-process) -> send every failure (input, expected, actual) back
 *   until green
 *
 * Run:  npx tsx testDrivenIteration.ts          (offline: scripted revisions)
 *       npx tsx testDrivenIteration.ts --live   (real Claude writes the code; tests still run locally)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";
import { MONEY_TEST, scriptedClaude } from "./scriptedFixes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RUNTIME = path.join(HERE, "..", ".lab-runtime", "tdd-ts");
const HARNESS = path.join(HERE, "migrationHarness.ts");
const TESTS = path.join(HERE, "migrationTests.ts");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAX_ROUNDS = 5; // a bound, not the stop signal: the loop stops when the tests pass
const TEST_TIMEOUT_MS = 30_000;

const SYSTEM =
  "You are implementing a data-migration module in TypeScript. Reply with the complete module in a single " +
  "```typescript block, followed by one line saying what you changed. Export migrateCustomer and migrateAll " +
  "with exactly the signatures the tests use, and do not import anything.";

interface Result {
  name: string;
  input: unknown;
  expected: unknown;
  actual: unknown;
  error?: string;
  passed: boolean;
}

const firstPrompt = (testsSource: string) =>
  "Implement migration.ts so that this test suite passes. The tests were written first and ARE the " +
  "specification, including the null/missing-value cases and the performance requirement.\n\n" +
  "```typescript\n" + testsSource + "```";

function fixPrompt(code: string, failures: Result[]): string {
  const lines = [
    "The test suite still fails. Below is your current module and every failing test with its input, the " +
      "expected output and what your code actually returned. Fix all of them in one revision.",
    "",
    "Current module:",
    "```typescript\n" + code + "```",
    "",
    "Failing tests:",
  ];
  for (const f of failures) {
    lines.push(`- ${f.name}`, `    input:    ${JSON.stringify(f.input)}`, `    expected: ${JSON.stringify(f.expected)}`, `    actual:   ${f.error ?? JSON.stringify(f.actual)}`);
  }
  return lines.join("\n");
}

function extractCode(reply: string): string {
  const match = /```(?:typescript|ts)\n([\s\S]*?)```/.exec(reply);
  if (!match) throw new Error("Claude's reply had no ```typescript block");
  return match[1];
}

let subprocessRuns = 0;

/** Run the suite against `candidate` in a separate process with a timeout. */
function runTests(candidate: string): Result[] {
  subprocessRuns++;
  const proc = spawnSync(process.execPath, [TSX_CLI, HARNESS, candidate], { encoding: "utf-8", timeout: TEST_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  if (proc.error) return [{ name: "whole suite", input: "-", expected: `finish within ${TEST_TIMEOUT_MS / 1000}s`, actual: String(proc.error), passed: false }];
  const report = JSON.parse(proc.stdout || "{}") as { results?: Result[]; import_error?: string };
  if (report.import_error || !report.results?.length) {
    return [{ name: "module imports", input: "-", expected: "importable module", actual: report.import_error ?? proc.stderr.slice(-500), passed: false }];
  }
  return report.results;
}

lab.banner("D3.5  Test-driven iteration: tests first, then share failures until green");
rmSync(RUNTIME, { recursive: true, force: true });
const testsSource = readFileSync(TESTS, "utf-8").replace(/\r\n/g, "\n");
const client = lab.getClient(scriptedClaude);
let prompt = firstPrompt(testsSource);
const rounds: Array<{ prompt: string; failures: Result[] }> = [];

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system: SYSTEM, messages: [{ role: "user", content: prompt }] });
  const reply = lab.textOf(response);
  const code = extractCode(reply);
  const candidate = path.join(RUNTIME, `round${round}`, "migration.ts");
  mkdirSync(path.dirname(candidate), { recursive: true });
  writeFileSync(candidate, code, "utf-8");

  const results = runTests(candidate);
  const failures = results.filter((r) => !r.passed);
  rounds.push({ prompt, failures });
  lab.section(`Round ${round}: ${results.length - failures.length}/${results.length} passing`);
  console.log(`  Claude: ${reply.split("```").pop()?.trim() ?? ""}`);
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.error ?? JSON.stringify(f.actual)}`);
  if (!failures.length) break;
  prompt = fixPrompt(code, failures);
}

lab.section("Checks");
const counts = rounds.map((r) => r.failures.length);
console.log(`  failures per round: ${JSON.stringify(counts)}`);
lab.check(rounds[0].prompt.includes(testsSource), "the test suite existed first and was the spec in the very first prompt");
lab.check(counts[counts.length - 1] === 0, `the suite went green within the ${MAX_ROUNDS}-round bound`);
lab.check(subprocessRuns === rounds.length, "every round's tests ran in a separate process; model code was never imported here");
if (!lab.isLive()) {
  lab.check(JSON.stringify(counts) === "[8,1,0]", "each round's shared failures drove the next revision: 8 -> 1 -> 0");
  const second = rounds[1].prompt;
  lab.check(second.includes("keeps a null phone as null") && second.includes('"phone":null'), "the null-value edge case was sent as a concrete input plus expected output");
  const third = rounds[2].prompt;
  lab.check(
    third.includes(MONEY_TEST) && third.includes("120434") && third.includes("120435"),
    "round 3 saw the exact actual (120434) vs expected (120435), which pinpoints the float bug",
  );
}
