/**
 * D5.5 - Route a production batch: auto-accept, or queue for humans by risk x uncertainty.
 *
 * Thresholds come from the labelled validation set. In the production batch an extraction
 * goes to the human queue when:
 *   - its source document is contradictory (e.g. two different totals),
 *   - its segment failed the automation gate (contract.effective_date), or
 *   - its confidence is below the segment's calibrated threshold.
 * Reviewer capacity is limited, so the queue is ordered by risk (cost of the field being
 * wrong) x uncertainty (100 - confidence; 100 for contradictory sources). What does not
 * fit today waits: it is never auto-accepted just because the queue is full.
 *
 * Run:  npx tsx reviewRouting.ts      (pure computation; identical output in Python)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  PRODUCTION_COUNTS,
  PRODUCTION_SEED,
  REVIEW_CAPACITY,
  VALIDATION_COUNTS,
  VALIDATION_SEED,
  calibrateAll,
  fingerprint,
  generate,
  pct,
  route,
} from "./reviewData.ts";

const REASONS = ["contradictory source", "segment below the accuracy bar", "low confidence"];

lab.banner("D5.5  Review routing within limited reviewer capacity");
const thresholds = calibrateAll(generate(VALIDATION_SEED, VALIDATION_COUNTS));
const batch = generate(PRODUCTION_SEED, PRODUCTION_COUNTS, true);
console.log(`production batch (seed ${PRODUCTION_SEED}): ${fingerprint(batch)}`);
const { auto, queue } = route(batch, thresholds);
const today = queue.slice(0, REVIEW_CAPACITY);
const backlog = queue.slice(REVIEW_CAPACITY);

lab.section("Routing");
console.log(`  auto-accepted     ${String(auto.length).padStart(5)}  (${pct(auto.length, batch.length)} of extractions)`);
console.log(`  human queue       ${String(queue.length).padStart(5)}`);
for (const reason of REASONS) console.log(`    ${reason.padEnd(32)}${String(queue.filter((q) => q.reason === reason).length).padStart(5)}`);
console.log(`  reviewed today    ${String(today.length).padStart(5)}  (capacity ${REVIEW_CAPACITY}); waiting ${backlog.length}`);

lab.section("Top of the queue (priority = risk x uncertainty)");
console.log(`  ${"priority".padStart(8)}  ${"doc".padEnd(12)}${"field".padEnd(16)}${"conf".padStart(5)}  reason`);
for (const q of queue.slice(0, 8)) {
  console.log(`  ${String(q.priority).padStart(8)}  ${q.doc_id.padEnd(12)}${q.field.padEnd(16)}${String(q.confidence).padStart(5)}  ${q.reason}`);
}
console.log(`  ... last item reviewed today has priority ${today[today.length - 1].priority}; first waiting item ${backlog[0].priority}`);

lab.section("Checks");
const key = (x: { doc_id: string; field: string }) => `${x.doc_id}|${x.field}`;
const autoIds = new Set(auto.map(key));
lab.check(!auto.some((x) => x.contradictory), "no field from a contradictory document was auto-accepted");
lab.check(!auto.some((x) => x.segment === "contract.effective_date"), "nothing from the gated segment was auto-accepted");
lab.check(queue.every((q, i) => i === 0 || queue[i - 1].priority >= q.priority), "the queue is ordered by risk x uncertainty");
const top = queue[0].priority;
lab.check(
  queue.filter((q) => q.priority === top).every((q) => today.includes(q)) && top === 5 * 100,
  "every top-priority item (risk-5 field in a contradictory document) is reviewed in today's batch",
);
lab.check(
  today.length === REVIEW_CAPACITY && !backlog.some((q) => autoIds.has(key(q))),
  "capacity is respected and the overflow waits instead of being auto-accepted",
);
