/**
 * D5.3 - Error propagation anti-patterns side by side (sample question 8).
 *
 * The same six-subtopic research run with four subagent designs. The coordinator's recovery
 * policy and the synthesis step are identical in every run; only what the subagent reports
 * changes:
 *
 *   structured   envelope with failure_type, attempted_query, partial_results, alternatives  (Q8 A)
 *   generic      retries internally, then returns only "search unavailable"                  (Q8 B)
 *   suppress     catches the failure and returns an empty result marked success             (Q8 C)
 *   terminate    lets the exception reach a top-level handler that stops the workflow       (Q8 D)
 *
 * This file always runs offline: it compares architectures, not model output.
 *
 * Run:  npx tsx antiPatterns.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  PLAN,
  RECOVERY_ACTIONS,
  TRANSIENT,
  SearchFailed,
  decideRecovery,
  genericSubagent,
  raisingSubagent,
  structuredSubagent,
  suppressingSubagent,
  synthesize,
  type CoverageRow,
  type Envelope,
  type Subagent,
} from "./researchSystem.ts";

const FAILURE_TYPES = [...TRANSIENT, "access_denied", "not_found"];
// Ground truth from the simulation: which subtopics really hit a source failure on the first try.
const ACTUALLY_FAILED = PLAN.filter((p) => structuredSubagent(p.subtopic, p.source, p.query).status !== "success").map((p) => p.subtopic);

/** Fan out, one recovery round driven by decideRecovery, then synthesize. */
function runPipeline(subagent: Subagent): { report: string; rows: CoverageRow[]; recoveries: number } | null {
  const history = new Map<string, Envelope[]>();
  try {
    for (const p of PLAN) history.set(p.subtopic, [subagent(p.subtopic, p.source, p.query)]);
  } catch (exc) {
    if (!(exc instanceof SearchFailed)) throw exc;
    console.log(`  workflow terminated: ${exc.message}`); // the top-level handler: the whole workflow ends here
    return null;
  }
  let recoveries = 0;
  for (const p of PLAN) {
    const envs = history.get(p.subtopic) ?? [];
    const decision = decideRecovery(envs[envs.length - 1], p, false);
    if (RECOVERY_ACTIONS.includes(decision.action)) {
      recoveries += 1;
      envs.push(subagent(p.subtopic, decision.source ?? p.source, decision.query ?? p.query));
    }
  }
  const { report, rows } = synthesize(history);
  return { report, rows, recoveries };
}

function quality(rows: CoverageRow[], recoveries: number): Record<string, number> {
  const gaps = rows.filter((r) => r.status.startsWith("gap"));
  return {
    findings: rows.reduce((sum, r) => sum + r.findings, 0),
    "subtopics with findings": rows.filter((r) => r.findings > 0).length,
    "recovery attempts": recoveries,
    "successful recoveries": rows.filter((r) => r.note.includes("recovered via")).length,
    "false 'no data' claims": rows.filter((r) => r.status === "no published data" && ACTUALLY_FAILED.includes(r.subtopic)).length,
    "gaps disclosed": gaps.length,
    "gaps with failure detail": gaps.filter((r) => FAILURE_TYPES.some((ft) => r.note.includes(ft))).length,
  };
}

lab.banner("D5.3  Error propagation anti-patterns (always offline)");
console.log(`subtopics whose first source really failed: ${JSON.stringify(ACTUALLY_FAILED)}`);
const variants: Record<string, Subagent> = {
  structured: structuredSubagent,
  generic: genericSubagent,
  suppress: suppressingSubagent,
  terminate: raisingSubagent,
};
const scores: Record<string, Record<string, number> | null> = {};
for (const [name, subagent] of Object.entries(variants)) {
  lab.section(`${name} subagent`);
  const outcome = runPipeline(subagent);
  if (!outcome) {
    scores[name] = null;
    console.log("  no report produced: the findings already gathered were thrown away with the run");
    continue;
  }
  console.log(outcome.report.split("## Coverage\n\n")[1]);
  scores[name] = quality(outcome.rows, outcome.recoveries);
}

lab.section("Final report quality");
const good = scores.structured;
const generic = scores.generic;
const suppress = scores.suppress;
if (!good || !generic || !suppress) throw new Error("expected reports from the structured, generic and suppress runs");
console.log(`  ${"".padEnd(28)}` + Object.keys(variants).map((n) => n.padStart(12)).join(""));
for (const metric of Object.keys(good)) {
  const cells = Object.values(scores).map((s) => String(s === null ? "-" : s[metric]).padStart(12));
  console.log(`  ${metric.padEnd(28)}${cells.join("")}`);
}
console.log(`  ${"report produced".padEnd(28)}` + Object.values(scores).map((s) => (s === null ? "no" : "yes").padStart(12)).join(""));

lab.section("Checks");
lab.check(
  good["false 'no data' claims"] === 0 && good["gaps disclosed"] === 1 && good["gaps with failure detail"] === 1,
  "structured: no false claims; the one remaining gap is disclosed with its failure type",
);
lab.check(
  good.findings > Math.max(generic.findings, suppress.findings) && good["successful recoveries"] === 2,
  "structured: most findings, because the coordinator could pick the right recovery twice",
);
lab.check(
  suppress["false 'no data' claims"] === 3 && suppress["gaps disclosed"] === 0,
  "suppress: three failures became 'no published data' and the report claims full coverage",
);
lab.check(
  generic["successful recoveries"] === 0 && generic["gaps with failure detail"] === 0,
  "generic: blind retries of the same query failed again; no failure detail reached the report",
);
lab.check(generic.findings < good.findings - 4, "generic: the partial results were thrown away with the details");
lab.check(scores.terminate === null, "terminate: one failure ended the whole workflow; nothing was delivered");
