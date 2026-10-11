/**
 * D3.6 - Claude Code as a CI reviewer: -p, JSON output, a schema, and no duplicate comments.
 *
 *   claude -p "<review prompt>"                     non-interactive: run, print, exit (no hang)
 *          --output-format json                     machine-readable result envelope
 *          --json-schema "$(cat ci/...schema.json)" validated object lands in .structured_output
 *          --allowedTools "Read,Grep,Glob,Bash(git diff *)"
 *          --max-turns 12
 *
 * On a re-run after new commits, the findings already posted go back into the prompt; a client-side
 * reconcile step backs that up so a re-worded repeat never becomes a second comment.
 *
 * Run:  npx tsx ciReview.ts          (offline: fixture CLI results, dry-run GitHub payloads)
 *       npx tsx ciReview.ts --live   (runs the real `claude` CLI in example-repo/; never calls GitHub)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as lab from "../../shared/typescript/labkit.ts";

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLE_REPO = path.join(LAB, "example-repo");
export const FIXTURES = path.join(LAB, "fixtures");
export const SCHEMA_PATH = path.join(EXAMPLE_REPO, "ci", "review-findings.schema.json");
const WORKFLOWS = path.join(EXAMPLE_REPO, ".github", "workflows");
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff *)", "Bash(git log *)"];
const MAX_TURNS = 12;
const MARKER_RE = /<!-- claude-review (\{.*?\}) -->/;
const STOPWORDS = new Set(["a", "an", "the", "with", "for", "to", "of", "in", "on", "is", "and", "by", "be", "used", "but"]);

export const readText = (file: string) => readFileSync(file, "utf-8").replace(/\r\n/g, "\n");

export interface Finding {
  id: string;
  status: "new" | "still_open";
  file: string;
  line: number;
  severity: string;
  category: string;
  title: string;
  explanation: string;
  suggestion: string;
}

export interface ReviewOutput {
  findings: Finding[];
  resolved_prior_ids: string[];
  summary: string;
}

export interface CliResult {
  is_error: boolean;
  session_id: string;
  result: string;
  num_turns?: number;
  total_cost_usd?: number;
  structured_output?: ReviewOutput;
}

interface PriorFinding {
  id: string;
  category: string;
  title: string;
  file: string;
  line: number;
}

export function reviewPrompt(baseRef: string, prior: PriorFinding[]): string {
  let prompt =
    `Review the changes in this pull request (git diff origin/${baseRef}...HEAD) against the review ` +
    "criteria in CLAUDE.md. Report only real problems; use the line number in the new version of each file.";
  if (prior.length) {
    prompt +=
      "\n\nThese findings were already posted on this pull request by an earlier review:\n" +
      JSON.stringify(prior, null, 2) +
      "\nReport only issues that are NEW or STILL UNADDRESSED. For a prior issue that still exists, reuse its id " +
      "and set status to still_open. Put the ids of prior findings the new commits fixed in resolved_prior_ids. " +
      "Do not report anything else twice.";
  }
  return prompt;
}

/** The exact command line the CI job runs. -p is what keeps it from waiting for terminal input. */
export function buildArgv(prompt: string, schemaText: string, allowedTools = ALLOWED_TOOLS, maxTurns = MAX_TURNS): string[] {
  return ["claude", "-p", prompt, "--output-format", "json", "--json-schema", schemaText, "--allowedTools", allowedTools.join(","), "--max-turns", String(maxTurns)];
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);

/** Shell form for printing: long prompt shortened, schema shown the way the workflow passes it. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((arg, i) => {
      if (i > 0 && argv[i - 1] === "--json-schema") return '"$(cat ci/review-findings.schema.json)"';
      if (i > 0 && argv[i - 1] === "-p") return shellQuote(arg.slice(0, 70) + (arg.length > 70 ? "..." : ""));
      return shellQuote(arg);
    })
    .join(" ");
}

/** Live: run the CLI (stdin closed, timeout). Offline: load a recorded result envelope. */
export function runClaude(argv: string[], fixture: string, cwd = EXAMPLE_REPO): CliResult {
  if (!lab.isLive()) return JSON.parse(readText(fixture)) as CliResult;
  const proc = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf-8", timeout: 900_000, stdio: ["ignore", "pipe", "pipe"] });
  if (proc.error) throw new Error(`could not run claude (npm install -g @anthropic-ai/claude-code): ${String(proc.error)}`);
  if (proc.status !== 0) throw new Error(`claude exited ${proc.status}: ${proc.stderr.slice(-500)}`);
  return JSON.parse(proc.stdout) as CliResult;
}

type Schema = {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
};

/** A small JSON Schema subset check (Claude Code already validates; this is defense in depth). */
export function validate(value: unknown, schema: Schema, where = "$"): string[] {
  const typeOk: Record<string, (v: unknown) => boolean> = {
    object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === "string",
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === "boolean",
  };
  if (schema.type && !typeOk[schema.type](value)) return [`${where}: expected ${schema.type}`];
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (schema.type === "integer" && schema.minimum !== undefined && (value as number) < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
  if (schema.type === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${where}.${key}: required`);
    for (const [key, item] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validate(item, sub, `${where}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${where}.${key}: not allowed`);
    }
  }
  if (schema.type === "array" && schema.items) {
    const items = schema.items;
    (value as unknown[]).forEach((item, i) => errors.push(...validate(item, items, `${where}[${i}]`)));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Prior findings, reconciliation, and GitHub review payloads
// ---------------------------------------------------------------------------

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** Inline comment text. The hidden marker lets the next run recover what was already posted. */
function commentBody(f: Finding): string {
  const marker = JSON.stringify({ id: f.id, category: f.category, title: f.title });
  return `**[${f.severity}] ${f.title}**\n\n${f.explanation}\n\nSuggestion: ${f.suggestion}\n\n<!-- claude-review ${marker} -->`;
}

/** Body for POST /repos/{owner}/{repo}/pulls/{number}/reviews (one review, many inline comments). */
function reviewPayload(headSha: string, findings: Finding[], body: string): { commit_id: string; event: string; body: string; comments: ReviewComment[] } {
  return { commit_id: headSha, event: "COMMENT", body, comments: findings.map((f) => ({ path: f.file, line: f.line, side: "RIGHT", body: commentBody(f) })) };
}

/** What GET .../pulls/{number}/comments gives back, reduced to the findings this job posted. */
function priorFromComments(comments: Array<{ path: string; line: number; body: string }>): PriorFinding[] {
  const prior: PriorFinding[] = [];
  for (const c of comments) {
    const match = MARKER_RE.exec(c.body);
    if (match) prior.push({ ...(JSON.parse(match[1]) as { id: string; category: string; title: string }), file: c.path, line: c.line });
  }
  return prior;
}

const titleTokens = (title: string) => new Set((title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w)));

/** Lines shift between commits, so match on file + category + title similarity instead. */
function sameIssue(a: { file: string; category: string; title: string }, b: { file: string; category: string; title: string }): boolean {
  const ta = titleTokens(a.title);
  const tb = titleTokens(b.title);
  const inter = [...ta].filter((w) => tb.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  return a.file === b.file && a.category === b.category && inter / Math.max(1, union) >= 0.5;
}

interface Reconciled {
  toPost: Finding[]; // genuinely new -> inline comment
  stillOpen: Array<[string, string]>; // [current id, prior id] -> no new comment
  duplicates: Array<[string, string]>; // reported "new" but already posted
  resolved: string[];
  unconfirmed: string[]; // prior, neither resolved nor re-reported
}

function reconcile(output: ReviewOutput, prior: PriorFinding[]): Reconciled {
  const byId = new Map(prior.map((p) => [p.id, p] as [string, PriorFinding]));
  const result: Reconciled = { toPost: [], stillOpen: [], duplicates: [], resolved: output.resolved_prior_ids.filter((id) => byId.has(id)), unconfirmed: [] };
  const matched = new Set<string>();
  for (const finding of output.findings) {
    const match = byId.get(finding.id) ?? prior.find((p) => !result.resolved.includes(p.id) && sameIssue(finding, p));
    if (!match) {
      result.toPost.push(finding);
      continue;
    }
    matched.add(match.id);
    result.stillOpen.push([finding.id, match.id]);
    if (finding.status === "new") result.duplicates.push([finding.id, match.id]);
  }
  result.unconfirmed = prior.filter((p) => !matched.has(p.id) && !result.resolved.includes(p.id)).map((p) => p.id);
  return result;
}

// ---------------------------------------------------------------------------
// Workflow lint
// ---------------------------------------------------------------------------

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

function loadWorkflow(name: string): Workflow {
  const data = parseYaml(readText(path.join(WORKFLOWS, name))) as Workflow & { true?: Record<string, unknown> };
  data.on = data.on ?? data.true ?? {}; // YAML 1.1 parsers read a bare `on:` key as boolean true
  return data;
}

const steps = (wf: Workflow): Step[] => Object.values(wf.jobs).flatMap((job) => job.steps);

function lintWorkflows(): void {
  const cli = loadWorkflow("claude-pr-review.yml");
  const action = loadWorkflow("claude-code-action.yml");
  const review = steps(cli).find((s) => (s.run ?? "").includes("claude -p"));
  const posting = steps(cli).find((s) => (s.run ?? "").includes("reviews"));
  const usesStep = steps(action).find((s) => (s.uses ?? "").startsWith("anthropics/claude-code-action@"));
  if (!review || !posting || !usesStep) throw new Error("workflow steps not found");
  const claudeLines = steps(cli).flatMap((s) => (s.run ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("claude ")));
  console.log(`  claude-pr-review.yml: trigger ${JSON.stringify(Object.keys(cli.on))}, permissions ${JSON.stringify(cli.permissions)}`);
  console.log(`  claude-code-action.yml: uses ${usesStep.uses}`);
  lab.check(claudeLines.every((l) => `${l} `.includes(" -p ")), "every claude invocation uses -p (sample Q10: otherwise the job hangs on input)");
  lab.check(
    ["--output-format json", '--json-schema "$(cat ci/review-findings.schema.json)"', "--allowedTools", "--max-turns"].every((f) => (review.run ?? "").includes(f)),
    "the CLI step requests JSON output validated against ci/review-findings.schema.json",
  );
  lab.check(review.env?.ANTHROPIC_API_KEY === "${{ secrets.ANTHROPIC_API_KEY }}", "the API key comes from repository secrets, never from the file");
  lab.check(JSON.stringify(cli.permissions) === '{"contents":"read","pull-requests":"write"}', "least privilege: read code, write PR comments");
  lab.check((posting.run ?? "").includes('select(.status == "new")'), "only status == new findings become inline comments");
  lab.check(
    (usesStep.uses ?? "").endsWith("@v1") && usesStep.with?.anthropic_api_key === "${{ secrets.ANTHROPIC_API_KEY }}" && (usesStep.with?.claude_args ?? "").includes("--max-turns"),
    "the alternative workflow uses anthropics/claude-code-action@v1 with the secret and claude_args",
  );
}

function main(): void {
  lab.banner("D3.6  Claude Code in CI: -p, --output-format json, --json-schema, dedupe on re-runs");
  const schemaText = readText(SCHEMA_PATH);
  const schema = JSON.parse(schemaText) as Schema;

  lab.section("Workflow lint (example-repo/.github/workflows)");
  lintWorkflows();

  lab.section("Push 1: first review of the pull request");
  const argv1 = buildArgv(reviewPrompt("main", []), schemaText);
  console.log(`  $ ${displayArgv(argv1)}`);
  const result1 = runClaude(argv1, path.join(FIXTURES, "review-run-1.json"));
  const out1 = result1.structured_output;
  if (!out1) throw new Error("no structured_output in the result");
  console.log(`  result: is_error=${result1.is_error} turns=${result1.num_turns} cost=$${result1.total_cost_usd}`);
  for (const f of out1.findings) console.log(`    ${f.severity.padEnd(9)}${f.category.padEnd(14)}${f.file}:${String(f.line).padEnd(4)} ${f.title}`);
  const payload1 = reviewPayload("a1b2c3d", out1.findings, `Claude review: ${out1.summary}`);
  console.log("  dry run: POST /repos/acme/payments-api/pulls/42/reviews (not sent)");
  console.log(JSON.stringify({ ...payload1, comments: payload1.comments.slice(0, 1) }, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
  console.log(`    ... ${payload1.comments.length} inline comments in total`);
  lab.check(argv1[0] === "claude" && argv1[1] === "-p" && argv1[argv1.indexOf("--output-format") + 1] === "json", "argv: claude -p ... --output-format json");
  lab.check(argv1[argv1.indexOf("--json-schema") + 1] === schemaText, "--json-schema receives the schema file's contents");
  lab.check(validate(out1, schema).length === 0, "structured_output conforms to ci/review-findings.schema.json");
  lab.check(
    payload1.comments.every((c) => JSON.stringify(Object.keys(c).sort()) === '["body","line","path","side"]' && MARKER_RE.test(c.body)),
    "each inline comment has path/line/side/body plus a hidden id marker",
  );

  lab.section("Push 2: the developer fixed some issues; review again");
  const posted = payload1.comments.map((c) => ({ path: c.path, line: c.line, body: c.body })); // what GitHub now holds
  const prior = priorFromComments(posted);
  const prompt2 = reviewPrompt("main", prior);
  const argv2 = buildArgv(prompt2, schemaText);
  console.log(`  prior findings recovered from PR comments: ${JSON.stringify(prior.map((p) => p.id))}`);
  const result2 = runClaude(argv2, path.join(FIXTURES, "review-run-2.json"));
  const out2 = result2.structured_output;
  if (!out2) throw new Error("no structured_output in the result");
  const rec = reconcile(out2, prior);
  console.log(`  resolved by the new commits : ${JSON.stringify(rec.resolved)}`);
  console.log(`  still open (no new comment) : ${JSON.stringify(rec.stillOpen)}`);
  console.log(`  duplicates suppressed       : ${JSON.stringify(rec.duplicates)}`);
  console.log(`  new -> inline comments      : ${JSON.stringify(rec.toPost.map((f) => f.id))}`);
  const still = rec.stillOpen.map(([, priorId]) => priorId).join(", ");
  const payload2 = reviewPayload("e4f5a6b", rec.toPost, `Claude re-review. Resolved: ${rec.resolved.join(", ")}. Still open: ${still}.`);
  console.log(`  dry run: POST .../pulls/42/reviews with ${payload2.comments.length} comment(s); summary: ${payload2.body}`);
  lab.check(prior.every((p) => prompt2.includes(p.id)), "the re-run prompt carries every previously posted finding");
  lab.check(validate(out2, schema).length === 0, "push-2 structured_output conforms to the schema too");
  lab.check(JSON.stringify([...rec.resolved].sort()) === '["card-number-logged","sql-injection-charge-lookup"]', "fixed issues are marked resolved, not re-posted");
  lab.check(rec.duplicates.some(([a, b]) => a === "float-refund-amount" && b === "float-money-conversion"), "a re-worded repeat ('Float arithmetic used for refund amount') is caught client-side");
  lab.check(JSON.stringify(rec.toPost.map((f) => f.id)) === '["idempotency-key-not-forwarded"]', "only the genuinely new issue becomes a new inline comment");
  lab.check(rec.unconfirmed.length === 0, "every prior finding is accounted for (resolved or still open)");
}

if (lab.isMain(import.meta.url)) main();
