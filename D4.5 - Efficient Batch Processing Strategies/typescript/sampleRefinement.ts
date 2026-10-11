/**
 * D4.5 - Refine the prompt on a small sample with the synchronous API BEFORE batching.
 *
 *   5 sample docs, sync API (answers in seconds) -> measure first-pass success
 *   v1 prompt: dates copied as printed           -> 60%: would fail ~10 of 24 in the batch
 *   v2 prompt: explicit JSON shape + YYYY-MM-DD  -> 100%: go
 *   then submit the full set once, instead of discovering the problem 24 hours later
 *
 * Run:  npx tsx sampleRefinement.ts          (offline, scripted model)
 *       npx tsx sampleRefinement.ts --live   (real Claude API, synchronous calls on the sample)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { PROMPT_V1, PROMPT_V2, buildRequest, extractionModel, makeDocuments, parseOutput, type ContractDoc } from "./batchWorkload.ts";

const GO_THRESHOLD = 0.95;

async function firstPassSuccess(client: lab.MessagesClient, system: string, docs: ContractDoc[]): Promise<[number, Record<string, string>]> {
  const failures: Record<string, string> = {};
  for (const doc of docs) {
    const { params } = buildRequest(doc.id, doc.text, system); // same params the batch will use
    const response = await client.messages.create(params);
    const [parsed, why] = parseOutput(lab.textOf(response));
    if (parsed === null) failures[doc.id] = why;
  }
  return [1 - Object.keys(failures).length / docs.length, failures];
}

lab.banner("D4.5  Prompt refinement on a sample before batching");
const docs = makeDocuments();
const sample = docs.filter((_, i) => i % 5 === 0); // 5 of 24, spread across the set
const client = lab.getClient(extractionModel);
console.log(`  sample: ${JSON.stringify(sample.map((d) => d.id))} (${sample.length} of ${docs.length} documents, synchronous API)`);

const results: Record<string, [number, string]> = {};
for (const [name, prompt] of [["v1", PROMPT_V1], ["v2", PROMPT_V2]] as const) {
  lab.section(`prompt ${name}`);
  const [rate, failures] = await firstPassSuccess(client, prompt, sample);
  const projected = Math.round((1 - rate) * docs.length);
  const decision = rate >= GO_THRESHOLD ? "GO: submit the full batch" : "REFINE: do not batch yet";
  results[name] = [rate, decision];
  for (const [docId, why] of Object.entries(failures)) console.log(`  ${docId}: ${why}`);
  console.log(`  first-pass success ${Math.round(rate * 100)}% -> projected failures in the full batch: ~${projected} -> ${decision}`);
}

lab.section("Why this order");
console.log("  A bad prompt found in the batch costs a full round trip (up to 24h) plus resubmitting");
console.log("  every failed document. Found on 5 synchronous calls, it costs seconds.");

if (!lab.isLive()) {
  lab.check(results.v1[0] < 0.8 && results.v1[1].startsWith("REFINE"), "v1 fails on the sample (dates as printed), so it is not batched");
  lab.check(results.v2[0] === 1 && results.v2[1].startsWith("GO"), "v2 passes every sample document: ready for the batch");
}
lab.check(sample.length <= Math.floor(docs.length / 4), "refinement ran on a small sample, not on the whole set");
