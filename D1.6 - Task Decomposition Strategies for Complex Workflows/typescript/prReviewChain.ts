/**
 * D1.6 (a) - Prompt chaining: a fixed review pipeline for a multi-file pull request.
 *
 *   step 1  per-file local pass     one focused call per file (only that file in context)
 *                                   -> local issues + exported interfaces + outgoing calls
 *   step 2  integration pass        ONE call that sees every file's report, not the sources
 *                                   -> cross-file mismatches (signature drift, data flow)
 *   step 3  merge                   plain code: combine both into the review
 *
 * PR #1482 changed billing.calculate_total(items, tax_rate) to calculate_total(items, region), but
 * api.py still calls it with tax_rate=. No single file is wrong on its own, so no per-file pass can
 * see it. The integration pass can. For contrast, a single pass over all files at once shows the
 * attention-dilution failure from sample question 12.
 *
 * Run:  npx tsx prReviewChain.ts          (offline, scripted reviewer)
 *       npx tsx prReviewChain.ts --live   (real Claude API, structured JSON outputs)
 */
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { EXAMPLES, chooseStrategy } from "./chooseStrategy.ts";
import { FIXTURES, readDir } from "./codeAnalysis.ts";
import { type CrossFileIssue, type FileReport, type Finding, scriptedModel } from "./scriptedModels.ts";

const PER_FILE_SYSTEM =
  "PER-FILE REVIEWER. You review exactly ONE file of a pull request. Report only issues you can verify " +
  "inside this file (bugs, error handling, edge cases), with line numbers. Also list the file's exported " +
  "function signatures and every call it makes to a symbol imported from another module, verbatim. " +
  "You cannot see other files: do not guess about them.";
const INTEGRATION_SYSTEM =
  "INTEGRATION REVIEWER. You receive per-file reports (summary, exported signatures, outgoing calls, local " +
  "issues) for every file in a pull request. Find problems that span files: calls that do not match the " +
  "callee's current signature, inconsistent data flow, and local issues that hide cross-file failures. " +
  "Do not repeat purely local issues.";
const SINGLE_PASS_SYSTEM = "SINGLE-PASS REVIEWER. Review every file of this pull request in one pass and list all issues.";

type Schema = Record<string, unknown>;
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str: Schema = { type: "string" };
const arrayOf = (items: Schema): Schema => ({ type: "array", items });

const FILE_REPORT_SCHEMA = obj({
  file: str,
  summary: str,
  local_issues: arrayOf(obj({ line: { type: "integer" }, issue: str })),
  exports: arrayOf(str),
  external_calls: arrayOf(obj({ symbol: str, module: str, call: str })),
});
const INTEGRATION_SCHEMA = obj({ cross_file_issues: arrayOf(obj({ caller: str, callee: str, issue: str })) });
const SINGLE_PASS_SCHEMA = obj({ findings: arrayOf(obj({ file: str, issue: str })) });

const fileBlock = (name: string, source: string) =>
  `### FILE: ${name}\n${source.endsWith("\n") ? source : `${source}\n`}### END FILE\n`;

/** One chain step. Structured outputs make the step's result machine-readable for the next step. */
async function askJson<T>(client: lab.MessagesClient, system: string, prompt: string, schema: Schema, sent: string[]): Promise<T> {
  sent.push(prompt);
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema } },
  });
  return JSON.parse(lab.textOf(response)) as T;
}

interface ReviewResult {
  reports: FileReport[];
  integration: { cross_file_issues: CrossFileIssue[] };
  comments: string[];
  prompts: string[];
}

async function reviewPr(client: lab.MessagesClient, files: Record<string, string>): Promise<ReviewResult> {
  const sent: string[] = [];
  // Step 1: one focused call per file. The calls are independent, so they could run in parallel.
  const reports: FileReport[] = [];
  for (const [name, src] of Object.entries(files)) {
    reports.push(await askJson<FileReport>(client, PER_FILE_SYSTEM, `PR #1482, one changed file:\n\n${fileBlock(name, src)}`, FILE_REPORT_SCHEMA, sent));
  }
  // Step 2: the integration pass sees compact reports (interfaces + calls), never the full sources.
  const integration = await askJson<{ cross_file_issues: CrossFileIssue[] }>(
    client,
    INTEGRATION_SYSTEM,
    `PR #1482.\nPER-FILE REPORTS:\n${JSON.stringify(reports, null, 2)}`,
    INTEGRATION_SCHEMA,
    sent,
  );
  // Step 3: merge (deterministic code, no model call).
  const comments = [
    ...reports.flatMap((r) => r.local_issues.map((i) => `${r.file}:${i.line}  ${i.issue}`)),
    ...integration.cross_file_issues.map((c) => `${c.caller} -> ${c.callee}  ${c.issue}`),
  ];
  return { reports, integration, comments, prompts: sent };
}

lab.banner("D1.6  Prompt chaining: per-file passes + cross-file integration pass");
const [strategy, reason] = chooseStrategy(EXAMPLES[0]);
console.log(`task: ${EXAMPLES[0].task}\nstrategy: ${strategy} (${reason})`);
const files = readDir(path.join(FIXTURES, "pr_1482"));
console.log(`files in PR: ${JSON.stringify(Object.keys(files))}`);

lab.section("Step 1: per-file local analysis (one call per file)");
const result = await reviewPr(lab.getClient(scriptedModel), files);
for (const report of result.reports) {
  console.log(`${report.file}: ${report.summary}`);
  console.log(`    exports: ${JSON.stringify(report.exports)}`);
  for (const issue of report.local_issues) console.log(`    line ${issue.line}: ${issue.issue}`);
}

lab.section("Step 2: cross-file integration pass");
for (const issue of result.integration.cross_file_issues) console.log(`  ${issue.caller} -> ${issue.callee}\n    ${issue.issue}`);

lab.section("Step 3: merged review comments");
for (const comment of result.comments) console.log(`  - ${comment}`);

lab.section("Contrast: one pass over all files at once");
const single = await askJson<{ findings: Finding[] }>(
  lab.getClient(scriptedModel),
  SINGLE_PASS_SYSTEM,
  `PR #1482:\n\n${Object.entries(files).map(([n, s]) => fileBlock(n, s)).join("")}`,
  SINGLE_PASS_SCHEMA,
  [],
);
for (const finding of single.findings) console.log(`  ${finding.file}: ${finding.issue}`);

lab.section("Checks");
const perFilePrompts = result.prompts.slice(0, -1);
const integrationPrompt = result.prompts[result.prompts.length - 1];
lab.check(perFilePrompts.every((p) => p.split("### FILE:").length === 2), "each per-file call had exactly one file in context");
lab.check(
  !integrationPrompt.includes("### FILE:") && Object.keys(files).every((n) => integrationPrompt.includes(n)),
  "the integration pass saw every file's report but no full sources",
);
if (!lab.isLive()) {
  const localText = result.reports.flatMap((r) => r.local_issues.map((i) => i.issue)).join(" ");
  lab.check(!localText.includes("tax_rate"), "no per-file pass flagged the signature change (the callee was not in its context)");
  const cross = result.integration.cross_file_issues;
  lab.check(
    cross.length === 1 && cross[0].caller === "api.py" && cross[0].callee === "billing.calculate_total" && cross[0].issue.includes("tax_rate"),
    "the integration pass caught api.py calling calculate_total(..., tax_rate=) after billing.py changed it",
  );
  lab.check(cross.every((c) => c.caller !== "reports.py"), "reports.py's correct call (region=...) was not flagged");
  const filesWithLocal = result.reports.filter((r) => r.local_issues.length).map((r) => r.file).sort();
  const singleFiles = new Set(single.findings.filter((f) => f.issue !== "Looks fine.").map((f) => f.file));
  lab.check(JSON.stringify(filesWithLocal) === JSON.stringify(["api.py", "billing.py", "cart.py"]), "per-file passes found the local bug in every file that has one");
  lab.check(!singleFiles.has("cart.py"), "the single pass skimmed later files and missed cart.py's off-by-one (attention dilution)");
}
