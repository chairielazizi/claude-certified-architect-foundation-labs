/**
 * D1.7 - Session state on the plain Messages API: the conversation history IS the session.
 *
 *   session store   .lab-runtime/messages_api/histories/<id>.json  (the full message list)
 *   registry        .lab-runtime/messages_api/sessions.json        (name -> id, file hashes, findings)
 *
 *   work session 1  new named session: list + read every file, record findings and hashes
 *   (edit 1 file)
 *   work session 2  resume: reload the history, append "these files changed: ...", re-read only those
 *   fork            deep-copy the history twice; each branch explores a different testing strategy
 *   (refactor 3 of 4 files)
 *   work session 3  >50% stale: start a NEW history seeded with a structured summary, no old tool results
 *
 * The Agent SDK does the storing for you (agentSdkSessions.ts); the decisions are the same.
 *
 * Run:  npx tsx messagesSessions.ts          (offline, scripted investigator)
 *       npx tsx messagesSessions.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { INVESTIGATE, STRATEGIES, SYSTEM_PROMPT, TOOLS, executeTool, parseFindings, scriptedInvestigator } from "./investigator.ts";
import {
  type Diff,
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

const ROOT = path.join(RUNTIME, "messages_api");
const WORKSPACE = path.join(ROOT, "workspace");
const NAME = "auth-investigation";
const SAFETY_MAX_ITERATIONS = 20;

type History = Anthropic.MessageParam[];

/** One JSON file per session id. Resume = load + append; fork = deep copy under a new id. */
class HistoryStore {
  private count = 0;
  private readonly dir: string;

  constructor(dir: string) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
  }

  newId(): string {
    this.count++;
    return `sess-${String(this.count).padStart(3, "0")}`;
  }

  save(sid: string, messages: History): void {
    writeFileSync(path.join(this.dir, `${sid}.json`), JSON.stringify(messages, null, 2), "utf-8");
  }

  load(sid: string): History {
    return JSON.parse(readFileSync(path.join(this.dir, `${sid}.json`), "utf-8")) as History;
  }
}

interface Call {
  name: string;
  input: Record<string, unknown>;
}

/** Agentic loop (see D1.1) over the session's history; returns the final text and the tool calls made. */
async function runTurn(client: lab.MessagesClient, messages: History): Promise<{ answer: string; calls: Call[] }> {
  const calls: Call[] = [];
  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system: SYSTEM_PROMPT, tools: TOOLS, messages });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "end_turn") return { answer: lab.textOf(response), calls };
    if (response.stop_reason !== "tool_use") throw new Error(`Unexpected stop_reason ${response.stop_reason}`);
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of lab.toolUses(response)) {
      const input = block.input as Record<string, unknown>;
      const [content, isError] = executeTool(WORKSPACE, block.name, input);
      calls.push({ name: block.name, input });
      results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error(`Turn did not finish in ${SAFETY_MAX_ITERATIONS} iterations`);
}

const reads = (calls: Call[]) => calls.filter((c) => c.name === "read_file").map((c) => String(c.input.path));
const toolResultsIn = (messages: History) =>
  messages.reduce((n, m) => n + (m.role === "user" && typeof m.content !== "string" ? m.content.filter((b) => b.type === "tool_result").length : 0), 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const indent = (text: string, pad = "  ") => pad + text.replace(/\n/g, `\n${pad}`);
const nonEmpty = (diff: Diff) => Object.fromEntries(Object.entries(diff).filter(([, v]) => (v as string[]).length));
const snapshot = () => hashFiles(WORKSPACE, listFiles(WORKSPACE));

function showFindings(findings: Findings): void {
  for (const [file, issues] of Object.entries(findings)) console.log(`    ${file}: ${issues.length ? issues.join("; ") : "no issues"}`);
}

function firstText(messages: History): string {
  const first = messages[0].content;
  return typeof first === "string" ? first : "";
}

lab.banner("D1.7  Resume, fork and fresh start with the Messages API (history = session)");
resetWorkspace(WORKSPACE);
const store = new HistoryStore(path.join(ROOT, "histories"));
const registry = new SessionRegistry(path.join(ROOT, "sessions.json"), true);
const client = lab.getClient(scriptedInvestigator);

lab.section("Work session 1: start the named investigation");
const sid = store.newId();
let history: History = [{ role: "user", content: INVESTIGATE }];
let turn = await runTurn(client, history);
store.save(sid, history);
let entry = registry.save(NAME, sid, snapshot(), parseFindings(turn.answer));
const session1 = structuredClone(history);
console.log(`  ${NAME} -> ${sid}; read ${JSON.stringify(reads(turn.calls))}`);
showFindings(entry.findings);
lab.check(same([...reads(turn.calls)].sort(), listFiles(WORKSPACE)), "session 1 explored every file");
lab.check(Object.keys(entry.files).length === 4 && Object.keys(entry.findings).length > 0, "registry stored 4 content hashes and the findings under the session name");

lab.section("Between work sessions: a developer edits auth/tokens.py");
applySmallEdit(WORKSPACE);

lab.section("Work session 2: resume by name with a targeted change notice");
entry = registry.get(NAME) as typeof entry;
let diff = diffSnapshot(entry.files, snapshot());
let decision = chooseResumeStrategy(diff);
console.log(`  diff: ${JSON.stringify(nonEmpty(diff))}`);
console.log(`  decision: ${decision.strategy} (${decision.reason})`);
history = store.load(entry.session_id); // resume = continue the stored conversation
const notice = buildChangeMessage(diff);
console.log(indent(notice));
history.push({ role: "user", content: notice });
turn = await runTurn(client, history);
store.save(sid, history);
let findings = mergeFindings(entry.findings, parseFindings(turn.answer), diff);
entry = registry.save(NAME, sid, snapshot(), findings);
console.log(`  re-read: ${JSON.stringify(reads(turn.calls))}`);
showFindings(findings);
lab.check(decision.strategy === "resume", "1 of 4 files changed -> resume (prior context mostly valid)");
lab.check(same(history.slice(0, session1.length), session1), "the resumed session still holds the full session-1 history");
if (!lab.isLive()) {
  lab.check(same(reads(turn.calls), ["auth/tokens.py"]), "targeted re-analysis: only the changed file was re-read");
  lab.check(same(findings["auth/tokens.py"], ["signing secret is hard-coded in source"]), "tokens.py: 'never expire' resolved, hard-coded secret still open");
}

lab.section("Fork: two testing strategies from the shared analysis baseline");
const baseline = store.load(sid);
const branches: { id: string; branch: History; answer: string }[] = [];
for (const [label, prompt] of Object.entries(STRATEGIES)) {
  const forkId = store.newId();
  const branch = structuredClone(baseline); // independent copy of the whole history
  branch.push({ role: "user", content: prompt });
  const { answer } = await runTurn(client, branch);
  store.save(forkId, branch);
  registry.save(`${NAME}/${label}`, forkId, entry.files, entry.findings);
  branches.push({ id: forkId, branch, answer });
  console.log(`  ${label} -> ${forkId} (forked from ${sid})\n${indent(answer, "    ")}`);
}
const [a, b] = branches;
const n = baseline.length;
lab.check(same(a.branch.slice(0, n), baseline) && same(b.branch.slice(0, n), baseline), `both branches share the ${n}-message baseline prefix`);
lab.check(!same(a.branch.slice(n), b.branch.slice(n)) && a.answer !== b.answer && a.id !== b.id, "the branches diverge after the baseline");
lab.check(store.load(sid).length === n, "forking did not modify the original session");
a.branch[0].content = `${firstText(a.branch)} (edited in branch A)`;
lab.check(firstText(b.branch) === INVESTIGATE && firstText(baseline) === INVESTIGATE, "branches are independent: an edit in A does not leak into B or the baseline");
const shallow = [...baseline];
shallow[0].content = `${firstText(shallow)} (edited)`;
lab.check(firstText(baseline) !== INVESTIGATE, "contrast: a shallow copy shares message objects, so the edit leaked into the baseline");

lab.section("Between work sessions: a refactor touches most of the package");
applyRefactor(WORKSPACE);

lab.section("Work session 3: resume or start fresh?");
entry = registry.get(NAME) as typeof entry;
diff = diffSnapshot(entry.files, snapshot());
decision = chooseResumeStrategy(diff);
console.log(`  diff: ${JSON.stringify(nonEmpty(diff))}`);
console.log(`  decision: ${decision.strategy} (${decision.reason})`);
const summary = buildStructuredSummary(NAME, entry, diff);
console.log(indent(summary));
const newSid = store.newId();
history = [{ role: "user", content: summary }]; // NEW history: no stale tool results carried over
turn = await runTurn(client, history);
store.save(newSid, history);
const unchanged = diff.unchanged;
const carried = Object.fromEntries(Object.entries(entry.findings).filter(([f]) => unchanged.includes(f)));
findings = mergeFindings(carried, parseFindings(turn.answer), diff);
entry = registry.save(NAME, newSid, snapshot(), findings);
console.log(`  ${NAME} -> ${newSid} (lineage ${JSON.stringify(entry.lineage)}); re-read ${JSON.stringify(reads(turn.calls))}`);
showFindings(findings);
lab.check(decision.strategy === "fresh", "3 of 4 analysed files changed or deleted -> start fresh");
lab.check(toolResultsIn(history) === turn.calls.length, "the fresh session holds only its own tool results, none from earlier sessions");
lab.check(summary.includes("auth/tokens.py: signing secret is hard-coded") && summary.includes("- auth/middleware.py"), "summary carries still-valid findings and lists the deleted file");
lab.check(entry.session_id === newSid && same(entry.lineage, [sid]), "the name now points at the new session; the old id is kept in its lineage");
if (!lab.isLive()) {
  lab.check(same([...reads(turn.calls)].sort(), ["auth/login.py", "auth/oauth.py", "auth/session.py"]), "only the changed and added files were read");
  lab.check((findings["auth/oauth.py"] ?? []).some((i) => i.includes("verify=False")), "the fresh session found the new issue in oauth.py");
}

lab.section("choose_resume_strategy boundaries");
const half: Diff = { changed: ["a", "b"], added: [], deleted: [], unchanged: ["c", "d"] };
const most: Diff = { changed: ["a", "b"], added: [], deleted: ["c"], unchanged: ["d"] };
const none: Diff = { changed: [], added: [], deleted: [], unchanged: ["a", "b"] };
for (const [label, d] of [["2/4 changed", half], ["3/4 changed or deleted", most], ["nothing changed", none]] as [string, Diff][]) {
  console.log(`  ${label.padEnd(24)} -> ${chooseResumeStrategy(d).strategy}`);
}
lab.check(chooseResumeStrategy(half).strategy === "resume", "exactly 50% stale still resumes (threshold is > 50%)");
lab.check(chooseResumeStrategy(most).strategy === "fresh" && chooseResumeStrategy(none).strategy === "resume", "75% stale -> fresh; nothing changed -> resume");
