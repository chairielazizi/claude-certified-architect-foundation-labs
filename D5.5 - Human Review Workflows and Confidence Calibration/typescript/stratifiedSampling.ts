/**
 * D5.5 - Stratified random sampling of auto-accepted extractions.
 *
 * Auto-accepted extractions still need ongoing measurement: the validation set cannot
 * contain failure modes that only appear later. Here the production batch includes a new
 * contract template (layout "scanned_v2") whose governing_law field is misread with HIGH
 * confidence, so it sails through the calibrated threshold.
 *
 * Two audit designs with the same budget of 150 human checks:
 *   uniform     150 drawn from the whole auto-accepted pool (contracts are ~4% of it)
 *   stratified  50 drawn from each document type
 *
 * Reviewers label the sample (the lab knows the truth). Error clusters by (segment, layout)
 * with at least 3 sampled errors raise a novel-pattern alert.
 *
 * Run:  npx tsx stratifiedSampling.ts      (pure computation; identical output in Python)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  FIELDS,
  Mulberry32,
  PATTERN_MIN_ERRORS,
  PER_STRATUM,
  PRODUCTION_COUNTS,
  PRODUCTION_SEED,
  SAMPLE_SEED,
  VALIDATION_COUNTS,
  VALIDATION_SEED,
  calibrateAll,
  generate,
  pct,
  route,
  sampleWithoutReplacement,
  type Extraction,
} from "./reviewData.ts";

const ERROR_BAR_PCT = 1; // what calibration promised: at most 1% errors among auto-accepted items
const DOC_TYPES = Object.keys(FIELDS);

function audit(name: string, sample: Extraction[], auto: Extraction[]) {
  lab.section(`${name} sample (${sample.length} checks)`);
  console.log(`  ${"stratum".padEnd(10)}${"auto pool".padStart(10)}${"sampled".padStart(9)}${"errors".padStart(8)}${"error rate".padStart(12)}`);
  const flagged: string[] = [];
  for (const docType of DOC_TYPES) {
    const pool = auto.filter((x) => x.doc_type === docType).length;
    const drawn = sample.filter((x) => x.doc_type === docType);
    const errors = drawn.filter((x) => !x.correct).length;
    const over = errors * 100 > ERROR_BAR_PCT * drawn.length;
    if (over && drawn.length >= 30) flagged.push(docType);
    const note = over && drawn.length >= 30 ? "   <-- above the 1% bar" : drawn.length < 30 ? "   (too few to measure)" : "";
    console.log(
      `  ${docType.padEnd(10)}${String(pool).padStart(10)}${String(drawn.length).padStart(9)}${String(errors).padStart(8)}${pct(errors, drawn.length).padStart(12)}${note}`,
    );
  }
  const clusters = new Map<string, number>();
  for (const x of sample) {
    if (x.correct) continue;
    const k = `${x.segment} on layout ${x.layout}`;
    clusters.set(k, (clusters.get(k) ?? 0) + 1);
  }
  const alerts = [...clusters.entries()].filter(([, n]) => n >= PATTERN_MIN_ERRORS).map(([k]) => k);
  for (const k of alerts) console.log(`  ALERT novel error pattern: ${k} (${clusters.get(k)} sampled errors) -> pause auto-accept, re-validate`);
  if (!alerts.length) console.log("  no error cluster large enough to raise an alert");
  return { sample, flagged, alerts };
}

lab.banner("D5.5  Stratified sampling of high-confidence extractions");
const validation = generate(VALIDATION_SEED, VALIDATION_COUNTS);
const thresholds = calibrateAll(validation);
const { auto } = route(generate(PRODUCTION_SEED, PRODUCTION_COUNTS, true), thresholds);
console.log(`auto-accepted production extractions: ${auto.length}; audit budget ${3 * PER_STRATUM} checks (sampling seed ${SAMPLE_SEED})`);

let rng = new Mulberry32(SAMPLE_SEED);
const uniform = audit("Uniform", sampleWithoutReplacement(auto, 3 * PER_STRATUM, rng), auto);
rng = new Mulberry32(SAMPLE_SEED);
const stratifiedSample: Extraction[] = [];
for (const docType of DOC_TYPES) stratifiedSample.push(...sampleWithoutReplacement(auto.filter((x) => x.doc_type === docType), PER_STRATUM, rng));
const stratified = audit("Stratified", stratifiedSample, auto);

lab.section("Checks");
const contractsUniform = uniform.sample.filter((x) => x.doc_type === "contract").length;
lab.check(contractsUniform < 15, `uniform sampling gave the small contract stratum only ${contractsUniform} checks`);
lab.check(
  DOC_TYPES.every((t) => stratified.sample.filter((x) => x.doc_type === t).length === PER_STRATUM),
  `stratified sampling measured every document type with ${PER_STRATUM} checks`,
);
const target = "contract.governing_law on layout scanned_v2";
lab.check(
  JSON.stringify(stratified.alerts) === JSON.stringify([target]) && uniform.alerts.length === 0,
  "only the stratified audit caught the novel error pattern",
);
lab.check(JSON.stringify(stratified.flagged) === '["contract"]', "stratified error rates single out the contract stratum as above the 1% bar");
lab.check(validation.every((x) => x.layout === "standard"), "the failing layout never appeared in the validation set: calibration could not have caught it");
