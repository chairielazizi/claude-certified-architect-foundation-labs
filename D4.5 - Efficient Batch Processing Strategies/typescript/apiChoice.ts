/**
 * D4.5 - Synchronous API or Message Batches? Match the API to the workflow's latency needs.
 *
 *   someone is waiting (pre-merge check)          -> synchronous
 *   needs tool calls executed mid-task            -> synchronous (a batch request is one shot)
 *   latency-tolerant (overnight, weekly, nightly) -> Message Batches: 50% cost, up to 24h, no SLA
 *
 * Also shows WHY multi-turn tool use does not fit a batch: the request just ends on tool_use.
 *
 * Run:  npx tsx apiChoice.ts      (always offline: the batch part uses the simulated service)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { buildRequest, extractionModel, makeDocuments } from "./batchWorkload.ts";
import { FakeBatchService, SimClock } from "./fakeBatchService.ts";

const BATCH_MAX_HOURS = 24;

interface Workflow {
  name: string;
  blocking: boolean;
  deadlineHours: number;
  needsToolLoop: boolean;
}

const WORKFLOWS: Workflow[] = [
  { name: "pre-merge check", blocking: true, deadlineHours: 0.25, needsToolLoop: false },
  { name: "overnight tech-debt report", blocking: false, deadlineHours: 12, needsToolLoop: false },
  { name: "weekly compliance audit", blocking: false, deadlineHours: 72, needsToolLoop: false },
  { name: "nightly test generation", blocking: false, deadlineHours: 10, needsToolLoop: false },
  { name: "ticket triage agent (calls lookup tools)", blocking: false, deadlineHours: 24, needsToolLoop: true },
];

function chooseApi(w: Workflow): ["sync" | "batch", string] {
  if (w.blocking) return ["sync", "a developer is waiting; batches have no latency SLA (up to 24h)"];
  if (w.needsToolLoop) return ["sync", "batch requests cannot execute tools mid-request and continue"];
  let note = "50% cheaper";
  if (w.deadlineHours < BATCH_MAX_HOURS) note += "; usually done in < 1h, but a hard deadline under 24h is not guaranteed";
  return ["batch", note];
}

lab.banner("D4.5  Choosing synchronous vs Message Batches");

lab.section("1. chooseApi() per workflow");
const choices: Record<string, string> = {};
for (const w of WORKFLOWS) {
  const [api, why] = chooseApi(w);
  choices[w.name] = api;
  console.log(`  ${w.name.padEnd(42)} -> ${api.padEnd(5)}  (${why})`);
}

lab.section("2. Sample question 11: switch BOTH workflows to batch for the 50% saving?");
const verdicts: [string, string][] = [
  ["A. batch for tech-debt reports only; real-time for pre-merge", "correct - matches each API to its latency need"],
  ["B. both to batch, with status polling", "wrong - polling does not make a 24h-max job safe to block a merge on"],
  ["C. keep both real-time to avoid result ordering issues", "wrong - custom_id correlates results in any order"],
  ["D. both to batch with a real-time fallback on timeout", "wrong - extra complexity for the simple answer A"],
];
for (const [option, verdict] of verdicts) console.log(`  ${option.padEnd(62)} ${verdict}`);

lab.section("3. Why a tool-calling workflow does not fit a batch");
const clock = new SimClock();
const service = new FakeBatchService(extractionModel, clock, 11);
const doc = makeDocuments(1)[0];
const request = buildRequest("triage-001", doc.text, "Look up the supplier's risk rating before answering.");
request.params.tools = [
  {
    name: "lookup_supplier_risk",
    description: "Risk rating for a supplier",
    input_schema: { type: "object", properties: { supplier: { type: "string" } }, required: ["supplier"] },
  },
];
const batch = await service.create({ requests: [request] });
while ((await service.retrieve(batch.id)).processing_status !== "ended") clock.advance(0.5);
const result = (await service.results(batch.id))[0];
const message = result.result.message;
console.log(
  `  batch ${batch.id} ended; ${result.custom_id}: stop_reason=${JSON.stringify(message?.stop_reason)}, ` +
    `tool call=${message ? lab.toolUses(message)[0].name : "-"}`,
);
console.log("  The request is finished. Running the tool and continuing needs a NEW request:");
console.log("  another batch round trip (up to 24h each) per tool step, or the synchronous API.");

lab.check(choices["pre-merge check"] === "sync", "blocking pre-merge check -> synchronous API");
lab.check(
  ["overnight tech-debt report", "weekly compliance audit", "nightly test generation"].every((n) => choices[n] === "batch"),
  "overnight report, weekly audit, nightly test generation -> Message Batches",
);
lab.check(choices["ticket triage agent (calls lookup tools)"] === "sync", "a multi-turn tool loop -> synchronous API");
lab.check(
  result.result.type === "succeeded" && message?.stop_reason === "tool_use",
  "a batched request that wants a tool simply ends on stop_reason 'tool_use' - nothing runs the tool",
);
