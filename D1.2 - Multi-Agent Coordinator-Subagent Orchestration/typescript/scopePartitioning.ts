/**
 * D1.2 - Scope partitioning and the coverage validator (sample question 7).
 *
 * Q7: on "impact of AI on creative industries" every subagent succeeded, yet the final report
 * covered only visual arts. The coordinator's log shows why: it decomposed the topic into
 * "AI in digital art creation", "AI in graphic design" and "AI in photography". The root cause
 * is the coordinator's decomposition, not the agents downstream of it.
 *
 *   1. run the validator on that exact decomposition -> missing music, writing, film
 *   2. put the validator inside the coordinator's planning loop -> the re-plan covers them
 *   3. show the resulting partition: distinct slices x distinct source types, no overlap
 *
 * Run:  npx tsx scopePartitioning.ts          (offline)
 *       npx tsx scopePartitioning.ts --live   (step 2 uses the real model as the coordinator)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { SOURCE_TYPES, Coordinator, printEvents } from "./coordinator.ts";
import { checklistFor, dimensionsOf, validateCoverage } from "./coverageValidator.ts";
import { COORDINATOR_PROMPT, CREATIVE_SUBTOPICS, ROLES, scriptedTeam, tag, type Subtopic } from "./researchTeam.ts";

const Q7_TOPIC = "impact of AI on creative industries";
const Q7_DECOMPOSITION: Subtopic[] = [
  { id: "st1", focus: "AI in digital art creation" },
  { id: "st2", focus: "AI in graphic design" },
  { id: "st3", focus: "AI in photography" },
];
/** One well-scoped slice per dimension (what the repaired plan uses). */
const SLICE_FOR: Record<string, string> = Object.fromEntries(
  CREATIVE_SUBTOPICS.map((st) => [dimensionsOf(st.focus, checklistFor(Q7_TOPIC))[0], st.focus]),
);

/**
 * Plays the sample-question-7 coordinator; every other role is the normal scripted team.
 * Its first decomposition covers visual arts only. Given the validator's feedback it repairs the
 * plan: merges the overlapping slices and adds one slice per missing dimension.
 */
function q7Coordinator(params: lab.CreateParams): Anthropic.Message {
  if (lab.systemText(params) !== COORDINATOR_PROMPT) return scriptedTeam(params);
  let subtopics: Subtopic[] = Q7_DECOMPOSITION;
  if (params.messages.length > 1) {
    const feedback = lab.lastUserText(params);
    const missing = JSON.parse(tag(feedback, "missing") || "[]") as string[];
    const overlaps = JSON.parse(tag(feedback, "overlaps") || "{}") as Record<string, string[]>;
    const previousTurn = params.messages[params.messages.length - 2].content;
    const previousText = typeof previousTurn === "string"
      ? previousTurn
      : previousTurn.map((b) => (b.type === "text" ? b.text : "")).join("");
    const previous = (JSON.parse(previousText) as { subtopics: Subtopic[] }).subtopics;
    const merged = new Set(Object.values(overlaps).flat());
    const kept = previous.filter((st) => !merged.has(st.id)).map((st) => st.focus);
    const focuses = [...kept, ...Object.keys(overlaps).map((d) => SLICE_FOR[d]), ...missing.map((d) => SLICE_FOR[d])];
    subtopics = focuses.map((focus, i) => ({ id: `st${i + 1}`, focus }));
  }
  const plan = { complexity: "broad", rationale: "Broad topic: one slice per creative sector.", subagents: [...ROLES], subtopics };
  return lab.message([lab.text(JSON.stringify(plan))]);
}

lab.banner("D1.2  Scope partitioning and coverage validation (sample question 7)");

lab.section("1. The coordinator's decomposition from sample question 7");
for (const st of Q7_DECOMPOSITION) console.log(`  ${st.id}: ${st.focus}`);
const report = validateCoverage(Q7_TOPIC, Q7_DECOMPOSITION);
console.log(`validator: required=${JSON.stringify(report.required)}`);
console.log(`           slice -> dimension ${JSON.stringify(report.slice_dimensions)}`);
console.log(`           missing=${JSON.stringify(report.missing)}  overlaps=${JSON.stringify(report.overlaps)}  ok=${report.ok}`);
console.log("Each subagent would complete these assignments correctly. The gap is in WHAT was assigned.");
lab.check(JSON.stringify(report.missing) === '["music","writing","film"]', "validator flags exactly what the Q7 report missed: music, writing, film");
lab.check(JSON.stringify(report.overlaps) === '{"visual_arts":["st1","st2","st3"]}', "all three slices crowd into visual arts, so their sources would overlap");

lab.section("2. The validator inside the coordinator's planning loop");
const coordinator = new Coordinator(lab.getClient(q7Coordinator));
const plan = await coordinator.plan(Q7_TOPIC);
printEvents(coordinator);
const accepted = plan.coverage;
console.log("accepted plan:");
for (const st of plan.subtopics) console.log(`  ${st.id}: ${st.focus}   -> ${JSON.stringify(accepted ? accepted.slice_dimensions[st.id] : [])}`);
lab.check(accepted !== undefined && accepted.ok, "the accepted plan covers every required dimension with no overlap");
lab.check(coordinator.subagentRequests.length === 0, "the decomposition is checked before anything is delegated (0 subagent calls)");
if (!lab.isLive()) {
  lab.check(coordinator.plans.length === 2, "plan 1 (visual arts only) was rejected; the re-plan built from the feedback passed");
}

lab.section("3. The partition: distinct slices x distinct source types");
const assignments: string[] = [];
console.log(`  ${"slice".padEnd(5)} ${"dimension".padEnd(12)} ${"web_search".padEnd(24)} document_analysis`);
for (const st of plan.subtopics) {
  const dimension = accepted ? accepted.slice_dimensions[st.id][0] : st.id;
  for (const role of ["web_search", "document_analysis"] as const) assignments.push(`${dimension}|${SOURCE_TYPES[role][0]}`);
  console.log(`  ${st.id.padEnd(5)} ${dimension.padEnd(12)} ${"news + web articles".padEnd(24)} reports + papers`);
}
lab.check(new Set(assignments).size === assignments.length, "no two assignments share a (dimension, source type), so no duplicated research");
