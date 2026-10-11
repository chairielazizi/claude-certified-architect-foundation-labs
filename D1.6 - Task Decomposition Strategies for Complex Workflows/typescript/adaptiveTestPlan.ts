/**
 * D1.6 (b) - Dynamic adaptive decomposition: "add comprehensive tests to a legacy codebase".
 *
 *   1. map structure        code: import graph, fan-in, existing tests, criticality tags
 *   2. find high impact     impact = 2*fan_in + criticality + (no tests yet)
 *   3. prioritized plan     planner model call -> JSON task list
 *   4. execute + adapt      worker model call per task; a worker that hits a missing dependency
 *                           (DB fake, clock, HTTP stub) reports it, and the planner inserts a
 *                           fixture task, attaches it to every task that will need it, and
 *                           re-prioritizes. Repeat until the plan is done.
 *
 * Nobody could write the final task list up front: the fixtures it contains were discovered by
 * running the earlier tasks. That is the difference from the fixed pipeline in prReviewChain.ts.
 *
 * Run:  npx tsx adaptiveTestPlan.ts          (offline, scripted planner + worker)
 *       npx tsx adaptiveTestPlan.ts --live   (real Claude API, structured JSON outputs)
 */
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { EXAMPLES, chooseStrategy } from "./chooseStrategy.ts";
import { FIXTURES, type ModuleInfo, mapRepo, readDir } from "./codeAnalysis.ts";
import { type Missing, type Plan, type Task, type WorkerResult, scriptedModel } from "./scriptedModels.ts";

const REPO = path.join(FIXTURES, "legacy_shop");
const SAFETY_MAX_STEPS = 40; // runaway guard; hitting it is a bug

const PLANNER_SYSTEM =
  "TEST PLANNER. You plan how to add comprehensive tests to a legacy codebase. Given the repo map " +
  "(imports, fan-in, criticality, existing tests) produce a prioritized task list: write_tests tasks for " +
  "high-impact untested modules first. When STATE contains a discovery (a task was blocked by a missing " +
  "test dependency), return the revised list of pending tasks: add a build_fixture task for each missing " +
  "fixture (reuse existing fixture tasks), add it to depends_on of every pending task that will need it, " +
  "and re-prioritize (1 = run first).";
const WORKER_SYSTEM =
  "TEST WORKER. You write unit tests for one module, or build one shared test fixture. If testing the " +
  "module needs a fixture that is not in available_fixtures (a DB fake, a frozen clock, an HTTP or SMTP " +
  "stub), do not write brittle tests: return status 'blocked' and list each missing fixture in snake_case " +
  "with the reason.";

type Schema = Record<string, unknown>;
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str: Schema = { type: "string" };
const arrayOf = (items: Schema): Schema => ({ type: "array", items });

const TASK_SCHEMA = obj({
  id: str,
  kind: { type: "string", enum: ["write_tests", "build_fixture"] },
  target: str,
  priority: { type: "integer" },
  depends_on: arrayOf(str),
  reason: str,
});
const PLAN_SCHEMA = obj({ tasks: arrayOf(TASK_SCHEMA), notes: str });
const WORKER_SCHEMA = obj({
  status: { type: "string", enum: ["done", "blocked"] },
  tests_written: arrayOf(str),
  missing: arrayOf(obj({ fixture: str, reason: str })),
});

async function askJson<T>(client: lab.MessagesClient, system: string, state: unknown, schema: Schema): Promise<T> {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: `STATE:\n${JSON.stringify(state, null, 2)}` }],
    output_config: { format: { type: "json_schema", schema } },
  });
  return JSON.parse(lab.textOf(response)) as T;
}

function showPlan(version: number, tasks: Task[]): void {
  const parts = [...tasks]
    .sort((a, b) => a.priority - b.priority)
    .map((t) => `${t.id} ${t.kind.replace("_", " ")} ${t.target}${t.depends_on.length ? ` [after ${t.depends_on.join(",")}]` : ""}`);
  console.log(`  [plan v${version}] ${parts.join("\n              ")}`);
}

interface RunResult {
  initial: Task[];
  done: Task[];
  blocked: { task: string; target: string; missing: Missing[] }[];
  plannerCalls: number;
}

async function runAdaptivePlan(
  client: lab.MessagesClient,
  repoMap: Record<string, ModuleInfo>,
  sources: Record<string, string>,
): Promise<RunResult> {
  let plan = await askJson<Plan>(client, PLANNER_SYSTEM, { repo_map: repoMap }, PLAN_SCHEMA);
  const initial = plan.tasks.map((t) => ({ ...t }));
  console.log(`  planner: ${plan.notes}`);
  showPlan(1, initial);

  let pending = plan.tasks.map((t) => ({ ...t }));
  const done: Task[] = [];
  const blocked: RunResult["blocked"] = [];
  let plannerCalls = 1;
  let version = 1;
  for (let step = 0; step < SAFETY_MAX_STEPS; step++) {
    if (!pending.length) return { initial, done, blocked, plannerCalls };
    const doneIds = new Set(done.map((t) => t.id));
    const runnable = pending.filter((t) => t.depends_on.every((d) => doneIds.has(d)));
    if (!runnable.length) throw new Error(`Plan deadlocked: ${JSON.stringify(pending.map((t) => [t.id, t.depends_on]))}`);
    const task = runnable.reduce((best, t) =>
      t.priority < best.priority || (t.priority === best.priority && t.id < best.id) ? t : best,
    );

    const available = done.filter((t) => t.kind === "build_fixture").map((t) => t.target);
    const source = sources[task.target] ?? "";
    const result = await askJson<WorkerResult>(client, WORKER_SYSTEM, { task, source, available_fixtures: available }, WORKER_SCHEMA);

    if (result.status === "done") {
      console.log(`  run ${task.id} ${task.target}: done -> ${result.tests_written.length} test(s)`);
      pending = pending.filter((t) => t !== task);
      done.push(task);
      continue;
    }

    // Blocked: the discovery goes back to the planner, which revises the remaining plan.
    console.log(`  run ${task.id} ${task.target}: BLOCKED, needs ${result.missing.map((m) => m.fixture).join(", ")}`);
    blocked.push({ task: task.id, target: task.target, missing: result.missing });
    const discovery = { task_id: task.id, target: task.target, missing: result.missing };
    plan = await askJson<Plan>(client, PLANNER_SYSTEM, { repo_map: repoMap, done, pending, discovery }, PLAN_SCHEMA);
    plannerCalls++;
    version++;
    pending = plan.tasks.filter((t) => !doneIds.has(t.id));
    console.log(`  planner: ${plan.notes}`);
    showPlan(version, pending);
  }
  throw new Error(`Plan did not finish in ${SAFETY_MAX_STEPS} steps`);
}

lab.banner("D1.6  Dynamic decomposition: adaptive test plan for a legacy codebase");
const [strategy, reason] = chooseStrategy(EXAMPLES[1]);
console.log(`task: ${EXAMPLES[1].task}\nstrategy: ${strategy} (${reason})`);

lab.section("1-2. Map structure and score impact");
const repoMap = mapRepo(REPO);
console.log(`  ${"module".padEnd(17)}${"fan-in".padStart(7)}${"crit".padStart(8)}${"tests".padStart(7)}${"impact".padStart(8)}   imports`);
for (const [name, m] of Object.entries(repoMap).sort((a, b) => b[1].impact - a[1].impact)) {
  console.log(
    `  ${name.padEnd(17)}${String(m.fan_in).padStart(7)}${m.criticality.padStart(8)}${(m.has_tests ? "yes" : "no").padStart(7)}` +
      `${String(m.impact).padStart(8)}   ${m.imports.join(", ") || "-"}`,
  );
}

lab.section("3-4. Plan, execute, discover, re-plan");
const run = await runAdaptivePlan(lab.getClient(scriptedModel), repoMap, readDir(REPO));

lab.section("Checks");
const position = new Map(run.done.map((t, i) => [t.id, i] as [string, number]));
lab.check(
  run.done.every((t) => t.depends_on.every((d) => (position.get(d) ?? Infinity) < (position.get(t.id) ?? -1))),
  "every task ran after all of its dependencies",
);
lab.check(run.plannerCalls === 1 + run.blocked.length, "the planner was consulted again after every blocking discovery");
if (!lab.isLive()) {
  const initialTargets = run.initial.map((t) => t.target);
  const impacts = initialTargets.map((t) => repoMap[t].impact);
  lab.check(
    impacts.every((v, i) => i === 0 || impacts[i - 1] >= v) && !initialTargets.includes("utils.py"),
    "initial plan: untested modules by impact, utils.py skipped (has tests)",
  );
  const initialIds = new Set(run.initial.map((t) => t.id));
  const added = run.done.filter((t) => !initialIds.has(t.id));
  lab.check(added.length === 5 && added.every((t) => t.kind === "build_fixture"), "the plan adapted: 5 fixture tasks were discovered and inserted");
  const blockedTargets = new Set(run.blocked.map((b) => b.target));
  lab.check(
    !blockedTargets.has("models.py") && !blockedTargets.has("reports.py"),
    "one discovery re-planned other tasks: models.py and reports.py waited for fake_db and were never blocked",
  );
  lab.check(run.done.length === run.initial.length + added.length, "every planned and discovered task completed");
}
