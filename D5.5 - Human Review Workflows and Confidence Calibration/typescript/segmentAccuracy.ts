/**
 * D5.5 - Aggregate accuracy can hide a weak segment.
 *
 * 97% overall looks ready for automation. Broken down by document type and field, one
 * segment (contract.effective_date) is right only about two times in three. It is 3% of the
 * volume, so it barely moves the average. Validate by segment before reducing human review.
 *
 * Run:  npx tsx segmentAccuracy.ts      (pure computation; identical output in Python)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { FIELDS, VALIDATION_COUNTS, VALIDATION_SEED, fingerprint, generate, pct, segments } from "./reviewData.ts";

const BAR_PCT = 95; // accuracy a segment must reach before anyone talks about automating it

lab.banner("D5.5  Aggregate accuracy vs accuracy by document type and field");
const items = generate(VALIDATION_SEED, VALIDATION_COUNTS);
console.log(`labelled validation set (mulberry32 seed ${VALIDATION_SEED}): ${fingerprint(items)}`);

lab.section("Aggregate");
const correct = items.filter((x) => x.correct).length;
console.log(`  accuracy ${pct(correct, items.length)} over ${items.length} extractions -> passes a ${BAR_PCT}% bar`);

lab.section("By document type");
const byType = new Map<string, [number, number]>();
for (const docType of Object.keys(FIELDS)) {
  const group = items.filter((x) => x.doc_type === docType);
  const ok = group.filter((x) => x.correct).length;
  byType.set(docType, [ok, group.length]);
  console.log(`  ${docType.padEnd(10)} ${pct(ok, group.length).padStart(7)}  (${ok}/${group.length})`);
}

lab.section("By document type x field");
console.log(`  ${"doc type".padEnd(10)}${"field".padEnd(16)}${"n".padStart(5)}${"accuracy".padStart(10)}`);
const weak: string[] = [];
for (const [segment, group] of segments(items)) {
  const [docType, field] = segment.split(".");
  const ok = group.filter((x) => x.correct).length;
  const below = ok * 100 < BAR_PCT * group.length;
  if (below) weak.push(segment);
  console.log(
    `  ${docType.padEnd(10)}${field.padEnd(16)}${String(group.length).padStart(5)}${pct(ok, group.length).padStart(10)}` +
      (below ? "   <-- below the bar" : ""),
  );
}

lab.section("Checks");
const weakItems = items.filter((x) => weak.includes(x.segment));
const weakOk = weakItems.filter((x) => x.correct).length;
lab.check(correct * 1000 >= 970 * items.length, "the aggregate is about 97%: it looks ready for automation");
lab.check(JSON.stringify(weak) === '["contract.effective_date"]', "exactly one segment is below the bar: contract.effective_date");
lab.check(weakOk * 100 < 75 * weakItems.length, "that segment is right only about 2 times in 3");
lab.check(weakItems.length * 100 <= 5 * items.length, "it is under 5% of the volume, which is why the aggregate hides it");
const [cOk, cN] = byType.get("contract") ?? [0, 0];
const [iOk, iN] = byType.get("invoice") ?? [0, 0];
const [rOk, rN] = byType.get("receipt") ?? [0, 0];
lab.check(cOk * 100 < BAR_PCT * cN && iOk * 100 >= 97 * iN && rOk * 100 >= 97 * rN, "by document type, contracts fail while invoices and receipts pass");
