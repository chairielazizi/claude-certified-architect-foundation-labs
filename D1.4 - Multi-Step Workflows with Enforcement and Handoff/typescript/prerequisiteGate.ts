/**
 * D1.4 - A programmatic prerequisite gate vs prompt-only enforcement (sample question 1).
 *
 *   A  The model tries process_refund with the name the customer typed. The gate in the
 *      tool-execution layer blocks it with a structured error naming the missing prerequisite
 *      (get_customer). The model verifies, looks the order up, and the refund goes through.
 *   B  100 synthetic runs. A prompt-guided model skips verification about 12% of the time
 *      (deterministic seeded PRNG, the rate from sample Q1). Prompt-only: every skip becomes an
 *      unverified refund credited via a name match. Gate: 0 violations, and every run still completes.
 *
 * Run:  npx tsx prerequisiteGate.ts          (offline)
 *       npx tsx prerequisiteGate.ts --live   (scenario A against the real API; B is always offline)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { SYSTEM_PROMPT, ToolLayer, makeSupportModel, ownerOf, runAgent } from "./supportTools.ts";

const REQUEST = "Hi, I'm Jordan Lee (jordan@example.com). My order ORD-1001 arrived damaged - please refund the $129.00.";
const RUNS = 100;
const SKIP_RATE = 0.12; // sample question 1: "in 12% of cases, your agent skips get_customer entirely"
const SEED = 20261011;

/** Park-Miller "minimal standard" PRNG: tiny, seedable, and identical in Python and TypeScript. */
function minstd(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647; // stays below 2^53, so exact in a JS number
    return state / 2147483647;
  };
}

type Totals = Record<"runs" | "skipped" | "blocked" | "unverified" | "misdirected" | "completed", number>;

/** Run the same 100 model behaviours through either tool layer and count what went wrong. */
async function simulate(enforce: boolean, skips: boolean[]): Promise<Totals> {
  const t: Totals = { runs: 0, skipped: 0, blocked: 0, unverified: 0, misdirected: 0, completed: 0 };
  for (const skip of skips) {
    const tools = new ToolLayer(enforce);
    await runAgent(new lab.ScriptedClient(makeSupportModel(skip)), REQUEST, tools, false);
    t.runs += 1;
    t.skipped += skip ? 1 : 0;
    t.blocked += tools.calls.filter((c) => c.outcome === "blocked").length;
    t.unverified += tools.refunds.filter((r) => !r.verified_at_time).length;
    t.misdirected += tools.refunds.filter((r) => r.credited_customer_id !== ownerOf(r.reference_id)).length;
    t.completed += tools.refunds.length;
  }
  return t;
}

lab.banner("D1.4  Programmatic prerequisite gate vs prompt-only enforcement");
console.log(`system prompt: ${SYSTEM_PROMPT}`);

lab.section("A - the gate blocks a refund attempted before verification");
console.log(`user: ${REQUEST}`);
const tools = new ToolLayer(true);
const { answer, messages } = await runAgent(lab.getClient(makeSupportModel(true)), REQUEST, tools);
console.log(`assistant: ${answer}`);
const sequence = tools.calls.map((c) => `${c.tool}:${c.outcome}`);
console.log(`tool calls: ${JSON.stringify(sequence)}`);

lab.check(tools.refunds.every((r) => r.verified_at_time && r.credited_customer_id === ownerOf(r.reference_id)),
  "every refund that ran had a verified customer and went to the order's owner");
if (!lab.isLive()) {
  const blocked = messages
    .flatMap((m) => (m.role === "user" && typeof m.content !== "string" ? m.content : []))
    .find((b) => b.type === "tool_result" && b.is_error);
  const error: Record<string, unknown> =
    blocked && blocked.type === "tool_result" ? (JSON.parse(lab.toolResultText(blocked)) as Record<string, unknown>) : {};
  lab.check(sequence[0] === "process_refund:blocked", "the first call, process_refund with the typed name, was blocked");
  lab.check(error.missing_prerequisite === "get_customer", "the blocked call came back as an is_error tool_result naming the missing prerequisite");
  lab.check(JSON.stringify(sequence.slice(1)) === JSON.stringify(["get_customer:ok", "lookup_order:ok", "process_refund:ok"]),
    "the model recovered: verified, looked up the order, then the refund succeeded");
}

lab.section(`B - ${RUNS} synthetic runs: prompt-only vs gate`);
const rng = minstd(SEED);
const skips = Array.from({ length: RUNS }, () => rng() < SKIP_RATE); // same behaviours for both modes
const promptOnly = await simulate(false, skips);
const gated = await simulate(true, skips);
console.log(`  ${"mode".padEnd(12)} ${"runs".padStart(4)} ${"skipped".padStart(8)} ${"blocked".padStart(8)} ${"unverified".padStart(11)} ${"misdirected".padStart(12)} ${"completed".padStart(10)}`);
for (const [label, t] of [["prompt-only", promptOnly], ["gate", gated]] as const) {
  console.log(`  ${label.padEnd(12)} ${String(t.runs).padStart(4)} ${String(t.skipped).padStart(8)} ${String(t.blocked).padStart(8)} ` +
    `${String(t.unverified).padStart(11)} ${String(t.misdirected).padStart(12)} ${String(t.completed).padStart(10)}`);
}
console.log("  (unverified = refund ran before get_customer succeeded; misdirected = credited to the other 'Jordan Lee')");

lab.check(promptOnly.skipped === 12, "the seeded model skipped verification in 12 of 100 runs (~12%)");
lab.check(promptOnly.unverified === 12 && promptOnly.misdirected === 12,
  "prompt-only: all 12 skips became unverified refunds credited to the wrong account");
lab.check(gated.unverified === 0 && gated.misdirected === 0, "gate: 0 violations");
lab.check(gated.blocked === 12 && gated.completed === RUNS, "gate: the 12 bad attempts were blocked and all 100 customers still got their refund");
