/**
 * D1.6 - Choosing a decomposition strategy before you start.
 *
 *   prompt chaining         the steps are known up front and the inputs are enumerable
 *                           (review each file, then an integration pass)
 *   dynamic decomposition   what you find decides what you do next
 *                           (map, prioritize, re-plan as dependencies surface)
 *
 * The decision is about the *task*, not the model: ask whether intermediate findings can create
 * new work. If they can, a fixed pipeline will either miss that work or do useless steps.
 *
 * Run:  npx tsx chooseStrategy.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";

export const PROMPT_CHAINING = "prompt_chaining";
export const DYNAMIC = "dynamic_decomposition";

export interface TaskProfile {
  task: string;
  fixed_steps: boolean; // the sequence of steps is known before starting
  bounded_scope: boolean; // inputs can be listed up front, e.g. the files of a PR
  findings_create_work: boolean; // results can add or reorder subtasks
  expected: string;
}

export function chooseStrategy(task: TaskProfile): [string, string] {
  if (task.findings_create_work) return [DYNAMIC, "intermediate findings add or reorder subtasks, so the plan must adapt"];
  if (!task.bounded_scope) return [DYNAMIC, "the scope is open-ended; map it first, then decide what to do"];
  if (task.fixed_steps) {
    return [PROMPT_CHAINING, "predictable steps over a known set of inputs; a fixed pipeline gives consistent depth"];
  }
  return [DYNAMIC, "no fixed sequence of steps is known up front"];
}

export const EXAMPLES: TaskProfile[] = [
  {
    task: "Review PR #1482 (4 files) for bugs, error handling and cross-file breakage",
    fixed_steps: true,
    bounded_scope: true,
    findings_create_work: false,
    expected: PROMPT_CHAINING,
  },
  {
    task: "Add comprehensive tests to the legacy_shop codebase",
    fixed_steps: false,
    bounded_scope: true,
    findings_create_work: true,
    expected: DYNAMIC,
  },
  {
    task: "Find out why checkout latency doubled since Tuesday's deploy",
    fixed_steps: false,
    bounded_scope: false,
    findings_create_work: true,
    expected: DYNAMIC,
  },
  {
    task: "Write release notes: summarize each of 30 merged PRs, then group them by product area",
    fixed_steps: true,
    bounded_scope: true,
    findings_create_work: false,
    expected: PROMPT_CHAINING,
  },
  {
    task: "Audit every API endpoint against a fixed checklist (auth, validation, rate limits)",
    fixed_steps: true,
    bounded_scope: true,
    findings_create_work: false,
    expected: PROMPT_CHAINING,
  },
  {
    task: "Find every path where customer PII can reach the logs and fix it",
    fixed_steps: false,
    bounded_scope: false,
    findings_create_work: true,
    expected: DYNAMIC,
  },
];

function main(): void {
  lab.banner("D1.6  choose_strategy(): prompt chaining vs dynamic decomposition");
  lab.section("Decisions");
  const results: boolean[] = [];
  for (const example of EXAMPLES) {
    const [strategy, reason] = chooseStrategy(example);
    results.push(strategy === example.expected);
    console.log(`- ${example.task}\n    -> ${strategy}: ${reason}`);
  }
  lab.check(results.every(Boolean), "every example task got the expected strategy");
  lab.check(chooseStrategy(EXAMPLES[0])[0] === PROMPT_CHAINING, "multi-file PR review -> prompt chaining (see prReviewChain.ts)");
  lab.check(chooseStrategy(EXAMPLES[1])[0] === DYNAMIC, "'add tests to a legacy codebase' -> dynamic decomposition (see adaptiveTestPlan.ts)");
}

// Run main() only when executed directly (the other demos import chooseStrategy).
if (lab.isMain(import.meta.url)) main();
