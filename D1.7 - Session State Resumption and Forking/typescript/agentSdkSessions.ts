/**
 * D1.7 - The same workflow on the Claude Agent SDK: named session, resume, fork, fresh restart.
 *
 *   work session 1   query(INVESTIGATE)                                  -> result message session_id
 *                    name it (CLI: claude -n / /rename; Python SDK: rename_session) + registry
 *   work session 2   query(change notice, { resume: sid })               -> the same conversation continues
 *   fork x2          query(strategy, { resume: sid, forkSession: true }) -> new ids, original untouched
 *   work session 3   >50% stale -> query(structured summary), no resume  -> a brand-new session
 *
 * Live: real Claude Code sessions (Read/Grep/Glob over the workspace; the CLI stores transcripts).
 * Offline: FakeAgentSessions mimics the SDK's session semantics (new id for a new session or a fork,
 * same id on resume, a fork copies the transcript) so the orchestration and its checks run without
 * the CLI. The resume-vs-fresh decisions come from the same registry code as messagesSessions.ts.
 *
 * Run:  npx tsx agentSdkSessions.ts          (offline stand-in for query())
 *       npx tsx agentSdkSessions.ts --live   (Agent SDK + real Claude; costs tokens)
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { INVESTIGATE, STRATEGIES, offlineAnswer, parseFindings } from "./investigator.ts";
import {
  type Findings,
  SessionRegistry,
  buildChangeMessage,
  buildStructuredSummary,
  chooseResumeStrategy,
  diffSnapshot,
  hashFiles,
  mergeFindings,
} from "./sessionRegistry.ts";
import { RUNTIME, applyRefactor, applySmallEdit, listFiles, resetWorkspace } from "./workspace.ts";

const ROOT = path.join(RUNTIME, "agent_sdk");
const WORKSPACE = path.join(ROOT, "workspace");
const NAME = "auth-investigation";
const SDK_SYSTEM_PROMPT =
  "You are investigating the auth package in the current directory for security issues. Use Read, Grep " +
  "and Glob; never guess file contents. When you finish an analysis, end your reply with one line exactly " +
  'like: FINDINGS_JSON: {"auth/file.py": ["finding", ...]} covering every file you read in this turn.';

interface SessionOpts {
  resume?: string;
  forkSession?: boolean;
}
type Runner = (prompt: string, opts: SessionOpts) => Promise<[string, string]>; // -> [session_id, result text]

/** Offline stand-in for query() that keeps the SDK's session semantics. */
class FakeAgentSessions {
  readonly transcripts: Record<string, string[]> = {};
  private count = 0;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private newId(): string {
    this.count++;
    return `00000000-0000-4000-8000-${String(this.count).padStart(12, "0")}`; // UUID-shaped, like real ids
  }

  run: Runner = async (prompt, opts) => {
    let sid: string;
    if (opts.resume && opts.forkSession) {
      sid = this.newId();
      this.transcripts[sid] = [...this.transcripts[opts.resume]]; // branch: copy; the original is untouched
    } else if (opts.resume) {
      sid = opts.resume; // the same session continues
    } else {
      sid = this.newId();
      this.transcripts[sid] = [];
    }
    const context: Findings = {};
    this.transcripts[sid].filter((_, i) => i % 2 === 1).forEach((earlier) => Object.assign(context, parseFindings(earlier)));
    const answer = offlineAnswer(this.root, prompt, context);
    this.transcripts[sid].push(prompt, answer);
    return [sid, answer];
  };
}

const runLive: Runner = async (prompt, opts) => {
  const options = {
    cwd: WORKSPACE,
    systemPrompt: SDK_SYSTEM_PROMPT,
    tools: ["Read", "Grep", "Glob"], // read-only investigation
    allowedTools: ["Read", "Grep", "Glob"],
    maxTurns: 20,
    model: lab.MODEL,
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(opts.forkSession ? { forkSession: true } : {}),
  };
  let sessionId = "";
  let result = "";
  for await (const message of query({ prompt, options })) {
    if (message.type === "result") {
      sessionId = message.session_id;
      result = message.subtype === "success" ? message.result : "";
    }
  }
  return [sessionId, result];
};

function nameSession(sid: string): void {
  // The Python SDK has rename_session(sid, title); here we keep the name in our own registry.
  // Either way the CLI can then find it: `claude --resume auth-investigation`.
  console.log(`  name '${NAME}' -> ${sid} (CLI equivalent: claude -n ${NAME}, or /rename inside a session)`);
}

const describe = (opts: SessionOpts) => JSON.stringify(opts);
const snapshot = () => hashFiles(WORKSPACE, listFiles(WORKSPACE));

lab.banner("D1.7  Named sessions, resume and forkSession with the Agent SDK");
resetWorkspace(WORKSPACE);
const registry = new SessionRegistry(path.join(ROOT, "sessions.json"), true);
const fake = new FakeAgentSessions(WORKSPACE);
const run: Runner = lab.isLive() ? runLive : fake.run;

lab.section("Work session 1: a named investigation");
console.log(`  query({ prompt: INVESTIGATE, options: ${describe({})} })   // no resume: a new session`);
const [sid, text1] = await run(INVESTIGATE, {});
console.log(`  result session_id = ${sid}`);
nameSession(sid);
registry.save(NAME, sid, snapshot(), parseFindings(text1));

lab.section("Between work sessions: a developer edits auth/tokens.py");
applySmallEdit(WORKSPACE);

lab.section("Work session 2: resume the named session");
let entry = registry.get(NAME);
if (!entry) throw new Error("registry lost the session");
let diff = diffSnapshot(entry.files, snapshot());
let decision = chooseResumeStrategy(diff);
console.log(`  registry: ${NAME} -> ${entry.session_id}; decision: ${decision.strategy} (${(decision.stale_ratio * 100).toFixed(0)}% stale)`);
const resumeOpts: SessionOpts = { resume: entry.session_id };
console.log(`  query({ prompt: <change notice>, options: ${describe(resumeOpts)} })`);
const [resumed, text2] = await run(buildChangeMessage(diff), resumeOpts);
console.log(`  session_id = ${resumed} (same as before: ${resumed === sid})`);
entry = registry.save(NAME, resumed, snapshot(), mergeFindings(entry.findings, parseFindings(text2), diff));
lab.check(decision.strategy === "resume", "1 of 4 files changed -> resume with a targeted change notice");
if (!lab.isLive()) lab.check(resumed === sid, "resume continues the same session id");

lab.section("Fork: two testing strategies from the shared baseline");
const baseline = [...(fake.transcripts[resumed] ?? [])];
const forks: Record<string, string> = {};
for (const [label, prompt] of Object.entries(STRATEGIES)) {
  const forkOpts: SessionOpts = { resume: resumed, forkSession: true };
  console.log(`  query({ prompt: <${label}>, options: ${describe(forkOpts)} })`);
  const [forkId, text] = await run(prompt, forkOpts);
  forks[label] = forkId;
  registry.save(`${NAME}/${label}`, forkId, entry.files, entry.findings);
  console.log(`    -> new session ${forkId}\n       ${text.replace(/\n/g, "\n       ")}`);
}
lab.check(new Set([...Object.values(forks), resumed]).size === 3, "each fork got its own new session id; the original id is unchanged");
if (!lab.isLive()) {
  lab.check(JSON.stringify(fake.transcripts[resumed]) === JSON.stringify(baseline), "forking left the original transcript untouched");
  lab.check(
    Object.values(forks).every((f) => JSON.stringify(fake.transcripts[f].slice(0, baseline.length)) === JSON.stringify(baseline)),
    "both forks start from the shared analysis baseline",
  );
}

lab.section("Between work sessions: a refactor touches most of the package");
applyRefactor(WORKSPACE);

lab.section("Work session 3: stale context -> fresh session with a structured summary");
entry = registry.get(NAME);
if (!entry) throw new Error("registry lost the session");
diff = diffSnapshot(entry.files, snapshot());
decision = chooseResumeStrategy(diff);
console.log(`  decision: ${decision.strategy} (${decision.reason})`);
console.log(`  query({ prompt: <structured summary>, options: ${describe({})} })   // no resume: a new session`);
const [fresh, text3] = await run(buildStructuredSummary(NAME, entry, diff), {});
const unchanged = diff.unchanged;
const carried = Object.fromEntries(Object.entries(entry.findings).filter(([f]) => unchanged.includes(f)));
entry = registry.save(NAME, fresh, snapshot(), mergeFindings(carried, parseFindings(text3), diff));
console.log(`  session_id = ${fresh}; ${NAME} lineage: ${JSON.stringify(entry.lineage)}`);
lab.check(decision.strategy === "fresh", "3 of 4 analysed files stale -> start a new session, not resume");
lab.check(
  ![sid, ...Object.values(forks)].includes(fresh) && JSON.stringify(entry.lineage) === JSON.stringify([sid]),
  "the name now points at the fresh session; the old id stays in the lineage",
);

lab.section("Registry on disk (.lab-runtime/agent_sdk/sessions.json)");
for (const [name, e] of Object.entries(registry.data)) console.log(`  ${name.padEnd(34)} ${e.session_id}  lineage=${JSON.stringify(e.lineage)}`);
console.log(`  ${JSON.stringify(entry.findings)}`);
