/**
 * D5.6 - Conflicting statistics are annotated, temporal differences are not conflicts.
 *
 * The analysis step groups claims and classifies each group:
 *
 *   established   one value (possibly from several sources)
 *   temporal      values differ but every value comes from a different data period
 *                 (4% for 2024, 9% for 2026-H1): a change over time, NOT a contradiction
 *   conflict      different values for the same period from credible sources
 *                 (USD 1.2 bn vs USD 0.8 bn for H1 2026): keep BOTH, annotated with sources
 *
 * The analysis completes with conflicts annotated and unresolved; the coordinator (a model
 * call with a record_reconciliation tool) decides how to reconcile before synthesis.
 *
 * Run:  npx tsx conflictsAndTemporal.ts          (offline)
 *       npx tsx conflictsAndTemporal.ts --live   (real model as coordinator)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { allClaims, analyze, periods, reconcile, scriptedModel, type Conflict } from "./provenance.ts";

lab.banner("D5.6  Conflicts annotated, temporal differences recognised");
const claims = allClaims();
const analysis = analyze(claims);

lab.section("Classification");
for (const g of analysis.groups) {
  const detail = g.variants.map((v) => `${v.value ?? "-"} (${periods(v).join(", ") || "n/a"})`).join("; ");
  console.log(`  ${g.status.padEnd(12)} ${g.claim_key.padEnd(26)} ${detail}`);
}

lab.section("Annotated conflicts handed to the coordinator");
const before = JSON.parse(JSON.stringify(analysis.conflicts)) as Conflict[]; // snapshot: the analysis output as-is
console.log(JSON.stringify(before, null, 2));

lab.section("Coordinator reconciliation");
const decisions = await reconcile(lab.getClient(scriptedModel), analysis.conflicts);
for (const [key, d] of decisions) console.log(`  ${key}: ${d.decision} - ${d.rationale}`);

lab.section("Checks");
const status = new Map(analysis.groups.map((g) => [g.claim_key, g.status]));
const funding = before.find((c) => c.claim_key === "ai_music_funding_2026h1");
lab.check(
  JSON.stringify(funding?.values.map((v) => v.value)) === '["1.2","0.8"]' && JSON.stringify(funding?.values.map((v) => v.sources)) === '[["S2"],["S5"]]',
  "the funding conflict keeps both values, each with its own source",
);
lab.check(before.every((c) => c.status === "unresolved"), "the analysis step annotated the conflict instead of picking a value");
lab.check(status.get("ai_track_streaming_share") === "temporal", "4% (2024) vs 9% (2026-H1) is classified as a temporal difference");
lab.check(
  JSON.stringify([...status.entries()].filter(([, s]) => s === "conflict").map(([k]) => k)) === '["ai_music_funding_2026h1"]',
  "only the same-period disagreement is a conflict",
);
const kept = analysis.groups.reduce((sum, g) => sum + g.variants.reduce((s, v) => s + v.citations.length, 0), 0);
lab.check(kept === claims.length, "the analysis completed without dropping any claim");
if (!lab.isLive()) {
  lab.check(
    decisions.get("ai_music_funding_2026h1")?.decision === "report_both_with_methodology",
    "the coordinator chose to report both values with their methodologies",
  );
}
