/**
 * D1.2 - The iterative refinement loop and the single error-handling wrapper, under failure.
 *
 * Both scenarios inject failures into the scripted subagents, so this file always runs offline.
 *
 *   A  document_analysis times out once on the music slice. delegate() turns the exception into
 *      a structured error event and the run carries on; synthesis reports music as a coverage
 *      gap; the coordinator's targeted follow-up succeeds; coverage converges.
 *   B  every film source stays unavailable. Each round re-delegates and fails again. After
 *      MAX_REFINEMENT_ROUNDS the coordinator throws CoverageNotConverged instead of publishing
 *      a report with a silent hole.
 *
 * Run:  npx tsx refinementLoop.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { MAX_REFINEMENT_ROUNDS, Coordinator, CoverageNotConverged, printEvents, type CoordinatorEvent } from "./coordinator.ts";
import { roleOf, scriptedTeam, tag } from "./researchTeam.ts";

const TOPIC = "impact of AI on creative industries";

/** Stand-in for a request timeout (the coordinator classifies errors by class name). */
class TimeoutError extends Error {}

/** The scripted team, except that selected subagent calls throw like a timed-out request. */
function failingTeam(shouldFail: (role: string, focus: string) => boolean): lab.Responder {
  return (params: lab.CreateParams): Anthropic.Message => {
    const role = roleOf(params);
    if (shouldFail(role, tag(lab.lastUserText(params), "slice").toLowerCase())) {
      throw new TimeoutError(`${role} call timed out after 30s`);
    }
    return scriptedTeam(params);
  };
}

/** Events worth printing here: failures, refinement decisions, synthesis and follow-ups. */
const interesting = (e: CoordinatorEvent) =>
  e.event === "error" || e.event === "refine" || e.role === "synthesis" || e.task.startsWith("gap-");

lab.banner("D1.2  Iterative refinement and error handling under failure (always offline)");

lab.section("A - one subagent call times out; the loop recovers");
let failedOnce = false;
const musicDocsFailOnce = (role: string, focus: string): boolean => {
  if (role === "document_analysis" && focus.includes("music") && !failedOnce) {
    failedOnce = true;
    return true;
  }
  return false;
};
const coordinatorA = new Coordinator(new lab.ScriptedClient(failingTeam(musicDocsFailOnce)));
const outcomeA = await coordinatorA.research(TOPIC);
console.log("event log (failures, refinement and synthesis only):");
printEvents(coordinatorA, interesting);
const errorsA = coordinatorA.events.filter((e) => e.event === "error");
const refinesA = coordinatorA.events.filter((e) => e.event === "refine");
lab.check(errorsA.length === 1 && errorsA[0].detail.startsWith("timeout (retryable=true)"),
  "the exception became one structured error event (timeout, retryable); the run did not crash");
lab.check(refinesA[0].detail.includes("music: no document evidence"), "synthesis reported the failed slice as a coverage gap");
lab.check(outcomeA.rounds === 2 && outcomeA.answer.includes("Music Rights Review"),
  "the coordinator's targeted re-delegation filled the gap; coverage converged in round 2");

lab.section("B - a source stays down; the loop is bounded");
const filmWords = ["film", "video", "vfx", "visual effects"];
const filmAlwaysFails = (role: string, focus: string): boolean =>
  (role === "web_search" || role === "document_analysis") && filmWords.some((w) => focus.includes(w));
const coordinatorB = new Coordinator(new lab.ScriptedClient(failingTeam(filmAlwaysFails)));
let raised: CoverageNotConverged | null = null;
try {
  await coordinatorB.research(TOPIC);
} catch (err) {
  if (!(err instanceof CoverageNotConverged)) throw err;
  raised = err;
}
console.log("event log (failures, refinement and synthesis only):");
printEvents(coordinatorB, interesting);
console.log(`raised: ${raised ? `${raised.name}: ${raised.message}` : "nothing"}`);

const errorsB = coordinatorB.events.filter((e) => e.event === "error");
const synthCalls = coordinatorB.events.filter((e) => e.event === "delegate" && e.role === "synthesis");
lab.check(raised !== null, "the coordinator threw CoverageNotConverged instead of returning a partial report");
lab.check(synthCalls.length === MAX_REFINEMENT_ROUNDS, `synthesis ran exactly MAX_REFINEMENT_ROUNDS=${MAX_REFINEMENT_ROUNDS} times`);
lab.check(errorsB.length > 1 && errorsB.every((e) => e.detail.startsWith("timeout (retryable=true)")),
  `all ${errorsB.length} failures went through the same wrapper and were logged the same way`);
lab.check(!coordinatorB.events.some((e) => e.role === "report"), "no report was written");
lab.check(raised !== null && JSON.stringify([...new Set(raised.gaps.map((g) => g.dimension))]) === '["film"]',
  "the exception names the dimension that never got covered");
