/**
 * D4.5 - How often must you submit batches to guarantee an SLA?
 *
 * A document that arrives just after a submission waits a full window for the next one, then the
 * batch may take the full 24h. So the worst case is  window + 24h (+ safety buffer), and the
 * longest window that still meets the SLA is
 *
 *     maxWindow = SLA - 24h max batch processing - safety buffer
 *
 * 30h SLA, 2h buffer -> submit every 4h (the exam's example).
 *
 * Run:  npx tsx slaCalculator.ts      (pure arithmetic + a simulation; no model calls)
 */
import * as lab from "../../shared/typescript/labkit.ts";

export const BATCH_MAX_HOURS = 24;

export function maxSubmissionWindow(slaHours: number, bufferHours = 2, batchMaxHours = BATCH_MAX_HOURS): number {
  return Math.max(0, slaHours - batchMaxHours - bufferHours);
}

/** Documents arrive every 15 minutes; each waits for the next submission, then takes the max 24h. */
export function simulateWorstLatency(windowHours: number, batchMaxHours = BATCH_MAX_HOURS, days = 3): number {
  let worst = 0;
  for (let step = 0; step < days * 24 * 4; step++) {
    const arrival = step * 0.25 + 0.01; // just AFTER a cutoff is the worst moment to arrive
    const submitted = Math.ceil(arrival / windowHours) * windowHours;
    worst = Math.max(worst, submitted + batchMaxHours - arrival);
  }
  return worst;
}

async function main(): Promise<void> {
  lab.banner("D4.5  Batch submission frequency from an SLA");

  lab.section("1. Max submission window per SLA (24h max processing, 2h buffer)");
  console.log(`  ${"SLA".padStart(5)}  ${"window".padStart(7)}  ${"submissions/day".padStart(16)}  worst-case latency`);
  const table: Record<number, number> = {};
  for (const sla of [24, 26, 30, 36, 48, 72]) {
    const window = maxSubmissionWindow(sla);
    table[sla] = window;
    if (window <= 0) {
      console.log(`  ${`${sla}h`.padStart(5)}  ${"-".padStart(7)}  ${"-".padStart(16)}  not achievable with batches -> use the synchronous API`);
      continue;
    }
    const perDay = Math.ceil(24 / window);
    console.log(
      `  ${`${sla}h`.padStart(5)}  ${`${window}h`.padStart(7)}  ${String(perDay).padStart(16)}  ${window + BATCH_MAX_HOURS}h + 2h buffer = ${sla}h`,
    );
  }

  lab.section("2. Simulated arrivals: does the 4h window really hold a 30h SLA?");
  const fourHourly = simulateWorstLatency(table[30]);
  const daily = simulateWorstLatency(24);
  console.log(`  submit every ${table[30]}h : worst observed latency ${fourHourly.toFixed(2)}h (SLA 30h, buffer 2h)`);
  console.log(`  submit once a day: worst observed latency ${daily.toFixed(2)}h  <- misses the SLA`);

  lab.check(table[30] === 4, "30h SLA - 24h max batch - 2h buffer = 4h submission windows");
  lab.check(table[26] === 0 && table[24] === 0, "an SLA at or under 24h + buffer cannot be guaranteed with batches");
  lab.check(fourHourly <= 30 - 2, "worst case with 4h windows stays inside SLA minus the buffer");
  lab.check(daily > 30, "a daily batch looks cheaper to run but breaks the 30h guarantee");
}

// batchPipeline.ts imports maxSubmissionWindow; only run the demo when executed directly.
if (lab.isMain(import.meta.url)) await main();
