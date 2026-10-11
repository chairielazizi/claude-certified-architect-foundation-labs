/**
 * D4.5 - A batch run end to end: submit, poll, correlate by custom_id, resubmit only failures.
 *
 *   24 requests, custom_id = document id
 *   poll retrieve() until processing_status == "ended"
 *   results arrive in ANY order -> key by custom_id, never by position
 *   errored (too long) -> chunk into doc-017#p1..pN    expired -> resubmit unchanged
 *   resubmit ONLY those, merge the parts, check the elapsed time against the 30h SLA
 *
 * Offline: FakeBatchService on a simulated clock (seeded: same result every run).
 * Live:    the real client.messages.batches API (lab.getRawClient()) with a tiny 3-document
 *          batch; polls every 30s.
 *
 * Run:  npx tsx batchPipeline.ts          (offline)
 *       npx tsx batchPipeline.ts --live   (real Message Batches API; results can take minutes)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  OVERSIZED,
  buildRequest,
  chunkDocument,
  extractionModel,
  makeDocuments,
  mergeParts,
  parseOutput,
  sameFields,
  type ContractDoc,
  type ContractFields,
} from "./batchWorkload.ts";
import {
  FAKE_CONTEXT_LIMIT_TOKENS,
  FakeBatchService,
  SimClock,
  type BatchRequest,
  type BatchResult,
  type BatchStatus,
  type BatchesLike,
} from "./fakeBatchService.ts";
import { maxSubmissionWindow } from "./slaCalculator.ts";

const SLA_HOURS = 30;
const WINDOW_HOURS = maxSubmissionWindow(SLA_HOURS); // 4h: the longest a document waits to be submitted
const LIVE_POLL_MS = 30_000;
const LIVE_MAX_POLLS = 120;

/** The real SDK batches resource behind the same minimal interface as the fake. */
function liveBatches(): BatchesLike {
  const raw = lab.getRawClient();
  return {
    create: async (body) => (await raw.messages.batches.create(body)) as unknown as BatchStatus,
    retrieve: async (id) => (await raw.messages.batches.retrieve(id)) as unknown as BatchStatus,
    results: async (id) => {
      const out: BatchResult[] = [];
      for await (const r of await raw.messages.batches.results(id)) out.push(r as unknown as BatchResult);
      return out;
    },
  };
}

function batchHours(status: BatchStatus): number {
  if (typeof status.created_at === "number" && typeof status.ended_at === "number") return status.ended_at - status.created_at;
  return (Date.parse(String(status.ended_at)) - Date.parse(String(status.created_at))) / 3_600_000; // SDK timestamps
}

async function runBatch(batches: BatchesLike, requests: BatchRequest[], wait: () => Promise<void>): Promise<[BatchResult[], number]> {
  const batch = await batches.create({ requests });
  console.log(`  created ${batch.id}: ${requests.length} requests, processing_status=${batch.processing_status}`);
  let status = batch;
  let polls = 0;
  while (status.processing_status !== "ended") {
    if (++polls > (lab.isLive() ? LIVE_MAX_POLLS : 10_000)) {
      console.log(`batch ${batch.id} still running; results stay available, re-check it later`);
      process.exit(0);
    }
    await wait();
    status = await batches.retrieve(batch.id);
  }
  const c = status.request_counts;
  console.log(`  ended after ${batchHours(status).toFixed(2)}h: succeeded=${c.succeeded} errored=${c.errored} expired=${c.expired}`);
  return [await batches.results(batch.id), batchHours(status)];
}

function collect(results: BatchResult[]): [Record<string, ContractFields>, Record<string, string>] {
  const extracted: Record<string, ContractFields> = {};
  const failed: Record<string, string> = {};
  for (const r of results) {
    // order is irrelevant: everything is keyed by custom_id
    if (r.result.type === "succeeded" && r.result.message) {
      const [parsed, why] = parseOutput(lab.textOf(r.result.message));
      if (parsed) extracted[r.custom_id] = parsed;
      else failed[r.custom_id] = `bad output: ${why}`;
    } else if (r.result.type === "errored" && r.result.error) {
      failed[r.custom_id] = `errored: ${r.result.error.error.type}: ${r.result.error.error.message}`;
    } else {
      failed[r.custom_id] = r.result.type; // expired | canceled
    }
  }
  return [extracted, failed];
}

lab.banner("D4.5  Message Batches: custom_id, failures, resubmission, SLA");
let docs: ContractDoc[];
let batches: BatchesLike;
let wait: () => Promise<void>;
let fake: FakeBatchService | null = null;
if (lab.isLive()) {
  docs = makeDocuments(3);
  batches = liveBatches();
  wait = () => new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
} else {
  docs = makeDocuments(24);
  const clock = new SimClock();
  fake = new FakeBatchService(extractionModel, clock, 7, [2, 0]);
  batches = fake;
  wait = async () => clock.advance(0.5);
}
const byId = new Map(docs.map((d) => [d.id, d]));
const docOf = (id: string): ContractDoc => {
  const d = byId.get(id);
  if (!d) throw new Error(`unknown custom_id ${id}`);
  return d;
};

lab.section("1. Submit every document, custom_id = document id");
const requests = docs.map((d) => buildRequest(d.id, d.text));
const [results, hours1] = await runBatch(batches, requests, wait);
console.log(`  submitted order: ${JSON.stringify(requests.slice(0, 6).map((r) => r.custom_id))} ...`);
console.log(`  returned order : ${JSON.stringify(results.slice(0, 6).map((r) => r.custom_id))} ...`);
const positionalMismatches = requests.filter((req, i) => results[i] && req.custom_id !== results[i].custom_id).length;
console.log(`  zipping results to requests by position would mislabel ${positionalMismatches} of ${results.length}`);
const [extracted, failed] = collect(results);
for (const [cid, reason] of Object.entries(failed).sort()) console.log(`  FAILED ${cid}: ${reason}`);
const correlatedOk = Object.entries(extracted).every(([cid, fields]) => fields.supplier === docOf(cid).truth.supplier);

lab.section("2. Resubmit ONLY the failures, modified where needed");
const resubmit: BatchRequest[] = [];
for (const [cid, reason] of Object.entries(failed).sort()) {
  if (reason.includes("invalid_request")) {
    // too long for one request: chunk it
    const parts = chunkDocument(cid, docOf(cid).text, Math.floor(FAKE_CONTEXT_LIMIT_TOKENS / 2));
    console.log(`  ${cid}: chunked into ${JSON.stringify(parts.map(([p]) => p))}`);
    resubmit.push(...parts.map(([partId, text]) => buildRequest(partId, text)));
  } else {
    // expired: the request itself was fine
    console.log(`  ${cid}: resubmitted unchanged (${reason})`);
    resubmit.push(buildRequest(cid, docOf(cid).text));
  }
}
let hours2 = 0;
if (resubmit.length) {
  const [results2, h2] = await runBatch(batches, resubmit, wait);
  hours2 = h2;
  const [extracted2, failed2] = collect(results2);
  for (const [cid, fields] of Object.entries(extracted2)) if (!cid.includes("#p")) extracted[cid] = fields;
  const bases = [...new Set(Object.keys(extracted2).filter((c) => c.includes("#p")).map((c) => c.split("#")[0]))].sort();
  for (const base of bases) {
    const partIds = Object.keys(extracted2)
      .filter((c) => c.startsWith(`${base}#p`))
      .sort((a, b) => Number(a.split("#p")[1]) - Number(b.split("#p")[1]));
    extracted[base] = mergeParts(partIds.map((p) => extracted2[p]));
    console.log(`  merged ${JSON.stringify(partIds)} -> ${JSON.stringify(extracted[base])}`);
  }
  for (const [cid, reason] of Object.entries(failed2)) console.log(`  STILL FAILED ${cid}: ${reason}`);
}

lab.section("3. Coverage and time against the SLA");
console.log(`  extracted ${Object.keys(extracted).length}/${docs.length} documents`);
const elapsed = hours1 + hours2;
console.log(
  `  worst wait for submission ${WINDOW_HOURS}h + batch 1 ${hours1.toFixed(2)}h + resubmission ${hours2.toFixed(2)}h = ` +
    `${(WINDOW_HOURS + elapsed).toFixed(2)}h (SLA ${SLA_HOURS}h)`,
);
console.log(`  guaranteed bound with a resubmission round: ${WINDOW_HOURS}h + 24h + 24h = ${WINDOW_HOURS + 48}h > SLA`);
console.log("  -> budget the retry round too, or send the few failures through the synchronous API.");

lab.check(docs.every((d) => d.id in extracted || d.id in failed), "every custom_id came back with a result");
if (fake) {
  const expired = Object.keys(failed).filter((c) => failed[c] === "expired");
  const second = fake.created[1] ?? [];
  const resubmittedDocs = new Set(second.map((c) => c.split("#")[0]));
  lab.check(Object.keys(extracted).length === docs.length, "every document ends up with a validated extraction");
  lab.check(correlatedOk, "each result was matched to its document by custom_id");
  lab.check(positionalMismatches > 0, "results came back shuffled: position-based matching would be wrong");
  lab.check(
    Object.keys(failed).length === 3 && expired.length === 2 && (failed[OVERSIZED] ?? "").startsWith("errored: invalid_request_error"),
    `round 1 failures: ${OVERSIZED} (too long, invalid_request_error) + 2 expired`,
  );
  lab.check(
    resubmittedDocs.size === Object.keys(failed).length && [...resubmittedDocs].every((c) => c in failed),
    "only failed custom_ids were resubmitted (no succeeded document paid for twice)",
  );
  lab.check(
    second.some((c) => c.startsWith(`${OVERSIZED}#p`)) && !second.includes(OVERSIZED),
    `${OVERSIZED} went back as chunks with custom_ids like ${OVERSIZED}#p1`,
  );
  lab.check(docs.every((d) => d.id in extracted && sameFields(extracted[d.id], d.truth)), "all 24 extractions match the source, including the merged chunks");
  lab.check(WINDOW_HOURS + elapsed <= SLA_HOURS, `this run finished inside the ${SLA_HOURS}h SLA`);
}
