/**
 * D3.4 - Plan mode or direct execution? Explicit criteria instead of gut feel.
 *
 *   plan mode         large or multi-file change, architectural / service-boundary decisions, several
 *                     valid approaches, approaches that differ in infrastructure, unclear requirements
 *   direct execution  well-scoped change with clear requirements (single-file fix with a clear stack
 *                     trace, adding one validation conditional)
 *
 * Run:  npx tsx taskRouter.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";

const MULTI_FILE_THRESHOLD = 3; // more files than this = a multi-file change whose dependencies need mapping

interface Task {
  description: string;
  estimatedFiles: number;
  architecturalDecision?: boolean; // service boundaries, module dependencies, data ownership
  multipleValidApproaches?: boolean;
  infrastructureChoice?: boolean; // the options differ in infrastructure (queues, new services, DBs)
  requirementsClear?: boolean; // default true
  clearStackTrace?: boolean;
  singleFunction?: boolean;
}

interface Route {
  mode: "plan mode" | "direct execution";
  reasons: string[];
  nextStep: string;
}

function route(task: Task): Route {
  const planSignals: string[] = [];
  if (task.estimatedFiles > MULTI_FILE_THRESHOLD) planSignals.push(`~${task.estimatedFiles} files: a multi-file change; map dependencies before editing`);
  if (task.architecturalDecision) planSignals.push("architectural decision (service boundaries / module dependencies)");
  if (task.multipleValidApproaches) planSignals.push("several valid approaches: compare them before committing to one");
  if (task.infrastructureChoice) planSignals.push("the approaches need different infrastructure: decide before building");
  if (task.requirementsClear === false) planSignals.push("requirements are unclear: investigate and clarify first");
  if (planSignals.length) {
    return {
      mode: "plan mode",
      reasons: planSignals,
      nextStep: "explore read-only (Explore subagent for verbose discovery), then directly execute the approved plan",
    };
  }
  const reasons: string[] = [];
  if (task.clearStackTrace) reasons.push("a clear stack trace pinpoints the failure");
  if (task.singleFunction) reasons.push("the change is confined to one function");
  reasons.push(`well-scoped (${task.estimatedFiles} file(s)) with clear requirements: planning adds overhead, not safety`);
  return { mode: "direct execution", reasons, nextStep: "make the change, run the tests" };
}

// The exam's own examples (task statement 3.4 and sample question 5), plus two boundary cases.
const EXAMPLES: Array<[Task, Route["mode"]]> = [
  [{ description: "Restructure the monolith into microservices", estimatedFiles: 60, architecturalDecision: true, multipleValidApproaches: true }, "plan mode"],
  [{ description: "Migrate from moment to date-fns (library migration, 45+ files)", estimatedFiles: 47, multipleValidApproaches: true }, "plan mode"],
  [
    { description: "Integrate the payment provider: polling job vs webhook endpoint + queue", estimatedFiles: 8, multipleValidApproaches: true, infrastructureChoice: true },
    "plan mode",
  ],
  [{ description: "Fix TypeError in parse_invoice (stack trace points at invoices.py:42)", estimatedFiles: 1, clearStackTrace: true, singleFunction: true }, "direct execution"],
  [{ description: "Add a date validation conditional: reject due_date before issue_date", estimatedFiles: 1, singleFunction: true }, "direct execution"],
  [{ description: "Checkout 'sometimes' fails for some users; no reproduction yet", estimatedFiles: 2, requirementsClear: false }, "plan mode"],
  [{ description: "Rename an internal helper used in 3 files", estimatedFiles: 3 }, "direct execution"],
];

lab.banner("D3.4  Task router: plan mode vs direct execution");
const results = EXAMPLES.map(([task, expected]) => ({ task, decision: route(task), expected }));
for (const { task, decision } of results) {
  console.log(`\n  ${task.description}\n    -> ${decision.mode.toUpperCase()}`);
  for (const reason of decision.reasons) console.log(`       - ${reason}`);
  console.log(`       next: ${decision.nextStep}`);
}

lab.section("Checks");
lab.check(results.every((r) => r.decision.mode === r.expected), "every exam example is routed as the exam expects");
lab.check(results[0].decision.reasons.some((r) => r.includes("architectural")), "sample Q5: microservices restructuring -> plan mode, because of the architectural decisions");
lab.check(
  results.filter((r) => r.decision.mode === "plan mode").every((r) => r.decision.nextStep.includes("approved plan")),
  "plan-mode tasks continue with direct execution of the approved plan",
);
const unclear = route({ description: "Make the daily report faster (cause unknown)", estimatedFiles: 1, requirementsClear: false });
lab.check(unclear.mode === "plan mode", "file count alone doesn't decide: an unclear one-file task still needs investigation first");
