/**
 * D3.6 - The reviewer must be an independent Claude Code invocation, not the generator's session.
 *
 * The session that wrote the code carries its own reasoning ("float is fine for two decimals").
 * Asking it to review (`claude -p --resume <generator-session> ...`) mostly confirms those assumptions.
 * A fresh `claude -p` run starts with no history and judges the diff against CLAUDE.md on its own.
 * --fork-session does not help: a fork copies the history. Always offline (recorded CLI results).
 *
 * Run:  npx tsx independentReview.ts
 */
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { FIXTURES, SCHEMA_PATH, buildArgv, displayArgv, readText, reviewPrompt, type CliResult, type Finding } from "./ciReview.ts";

const CONTEXT_REUSE_FLAGS = ["--resume", "-r", "--continue", "-c", "--fork-session"];

/** The anti-pattern: continue (or fork) the generator's conversation and ask it to review itself. */
function selfReviewArgv(generatorSession: string, schemaText: string, fork = false): string[] {
  return [
    "claude", "-p", "--resume", generatorSession, "Review the changes you just made for bugs.",
    ...(fork ? ["--fork-session"] : []),
    "--output-format", "json", "--json-schema", schemaText,
  ];
}

/** An independent reviewer reuses nothing from the generator's session. */
function isIndependent(argv: string[], generatorSession: string): [boolean, string[]] {
  const problems = CONTEXT_REUSE_FLAGS.filter((flag) => argv.includes(flag)).map((flag) => `${flag} reuses an earlier conversation`);
  if (argv.includes(generatorSession)) problems.push("references the generator's session id");
  return [problems.length === 0, problems];
}

const load = (name: string) => JSON.parse(readText(path.join(FIXTURES, name))) as CliResult;

lab.banner("D3.6  Independent review: a fresh claude -p run, not the generator's session");
const schemaText = readText(SCHEMA_PATH);
const generator = load("generator-run.json");
const session = generator.session_id;
console.log(`  generator session ${session} said:\n    ${generator.result}`);

lab.section("Anti-pattern: the generator reviews its own work");
const same = selfReviewArgv(session, schemaText);
const forked = selfReviewArgv(session, schemaText, true);
console.log(`  $ ${displayArgv(same)}`);
const selfResult = load("self-review-run.json");
const selfFindings: Finding[] = selfResult.structured_output?.findings ?? [];
console.log(`  -> session ${selfResult.session_id}: ${selfResult.result}`);
console.log(`     findings: ${JSON.stringify(selfFindings.map((f) => [f.severity, f.title]))}`);

lab.section("Independent reviewer: a separate invocation with no history");
const fresh = buildArgv(reviewPrompt("main", []), schemaText);
console.log(`  $ ${displayArgv(fresh)}`);
const review = load("review-run-1.json");
const findings: Finding[] = review.structured_output?.findings ?? [];
console.log(`  -> session ${review.session_id}`);
for (const f of findings) console.log(`     ${f.severity.padEnd(9)}${f.title}`);

lab.section("Checks");
const [okSame, whySame] = isIndependent(same, session);
const [okFork, whyFork] = isIndependent(forked, session);
const [okFresh] = isIndependent(fresh, session);
console.log(`  self-review problems: ${JSON.stringify(whySame)}\n  forked self-review problems: ${JSON.stringify(whyFork)}`);
lab.check(!okSame, "--resume <generator session> is not an independent review");
lab.check(!okFork, "--fork-session is not independent either: a fork starts from a copy of the history");
lab.check(okFresh, "the CI reviewer argv has no --resume / --continue / --fork-session");
lab.check(selfResult.session_id === session && review.session_id !== session, "the self-review continued the generator's session; the independent one has its own");
const critical = (fs: Finding[]) => fs.filter((f) => f.severity === "critical").length;
lab.check(critical(findings) === 3 && critical(selfFindings) === 0, "the independent reviewer found the 3 critical issues the self-review rationalized away");
