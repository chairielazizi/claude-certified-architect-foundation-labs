/**
 * D2.2 - Structured MCP errors vs "Operation failed": recovery decisions and wasted retries.
 *
 * Six scenarios run against the tool handlers (the same functions the McpServer registers):
 *   1. flaky backend: order service times out twice, then answers   -> transient
 *   2. refund of $900 (agent limit $500)                            -> business
 *   3. order id typed as "#1002"                                    -> validation
 *   4. KB search with no matches                                    -> SUCCESS, matched 0
 *   5. refund on a corporate account without the scope             -> permission
 *   6. multi-step task while the KB is down                         -> unresolved -> propagate
 *
 * Each runs three ways: structured server + envelope-reading policy, and the generic server
 * with each blind policy available to it (retry everything / retry nothing).
 * Always offline (no model involved). Run:  npx tsx recoveryDemo.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { POLICIES, callerFor, resultText, runSubtask, wastedRetries, type SubtaskReport } from "./recoveryPolicy.ts";
import { Backend, makeHandlers, type Style } from "./supportServer.ts";

type Setup = (b: Backend) => void;
type Step = [string, Record<string, unknown>];

const SCENARIOS: [string, Setup, Step[]][] = [
  ["1 flaky order service", (b) => { b.lookupTimeouts["ORD-1001"] = 2; }, [["lookup_order", { order_id: "ORD-1001" }]]],
  ["2 refund over policy", () => {}, [["process_refund", { order_id: "ORD-1001", amount: 900 }]]],
  ["3 malformed order id", () => {}, [["lookup_order", { order_id: "#1002" }]]],
  ["4 search, no matches", () => {}, [["search_kb", { query: "warp drive warranty" }]]],
  ["5 corporate refund", () => {}, [["process_refund", { order_id: "ORD-3003", amount: 40 }]]],
  [
    "6 KB outage mid-task",
    (b) => { b.kbDown = true; },
    [["lookup_order", { order_id: "ORD-1001" }], ["search_kb", { query: "headphone return window" }]],
  ],
];

// (server error style, agent policy)
const STRATEGIES: Record<string, [Style, string]> = {
  structured: ["structured", "structured"],
  "generic+retry_all": ["generic", "retry_all"],
  "generic+no_retry": ["generic", "no_retry"],
};

async function run(setup: Setup, steps: Step[], strategy: string): Promise<[SubtaskReport, Backend]> {
  const [style, policy] = STRATEGIES[strategy];
  const backend = new Backend(); // fresh state per run so every strategy sees the same failures
  setup(backend);
  const report = await runSubtask(callerFor(makeHandlers(backend, style)), steps, POLICIES[policy]);
  return [report, backend];
}

function finalStatus(report: SubtaskReport): string {
  if (report.status === "complete") return report.results[report.results.length - 1].status;
  return report.unresolved ? report.unresolved.status : "unknown";
}

lab.banner("D2.2  Structured MCP error responses and agent-side recovery");

lab.section("What travels over MCP for a business-rule failure (wire shape)");
const wire = await makeHandlers(new Backend(), "structured").process_refund({ order_id: "ORD-1001", amount: 900 });
console.log(JSON.stringify(wire, null, 2));
const genericWire = await makeHandlers(new Backend(), "generic").process_refund({ order_id: "ORD-1001", amount: 900 });
console.log(`generic variant: isError=${genericWire.isError} text=${resultText(genericWire)}`);

const totals: Record<string, { wasted: number; calls: number }> = {};
for (const s of Object.keys(STRATEGIES)) totals[s] = { wasted: 0, calls: 0 };
const table: [string, Record<string, string>][] = [];
const reports = new Map<string, SubtaskReport>();
const key = (title: string, strategy: string) => `${title}|${strategy}`;

for (const [title, setup, steps] of SCENARIOS) {
  lab.section(`Scenario ${title}`);
  const row: Record<string, string> = {};
  for (const strategy of Object.keys(STRATEGIES)) {
    const [report, backend] = await run(setup, steps, strategy);
    reports.set(key(title, strategy), report);
    const wasted = wastedRetries(backend.log);
    totals[strategy].wasted += wasted;
    totals[strategy].calls += backend.log.length;
    row[strategy] = `${finalStatus(report)} calls=${backend.log.length}`;
    console.log(`  ${strategy.padEnd(18)} -> ${finalStatus(report).padEnd(13)} calls=${backend.log.length} wasted_retries=${wasted}`);
    if (strategy === "structured") {
      for (const a of report.attempts) {
        console.log(`      attempt ${a.tool}(${JSON.stringify(a.args)}) -> ${a.outcome}  ${a.then ?? ""}`);
      }
      for (const r of report.results) if (r.customerMessage) console.log(`      customerMessage: ${r.customerMessage}`);
    }
  }
  table.push([title, row]);
}

const get = (title: string, strategy = "structured"): SubtaskReport => {
  const r = reports.get(key(title, strategy));
  if (!r) throw new Error(`missing report ${title}`);
  return r;
};

lab.section("Scenario 6: what the subagent propagates to the coordinator");
const report6 = get("6 KB outage mid-task");
lab.show("structured report (attempts abridged)", {
  ...report6,
  results: report6.results.map((r) => ({ tool: r.tool, status: r.status, result: { order_id: r.result?.order_id, status: r.result?.status } })),
  attempts: report6.attempts.map((a) => `${a.tool} -> ${a.outcome}`),
});
const generic6 = get("6 KB outage mid-task", "generic+retry_all");
console.log(`generic variant propagates only: ${JSON.stringify(generic6.unresolved?.error)}`);
console.log("  -> the coordinator cannot tell 'KB down, try later / use cached policy' from 'bad query'");

lab.section("Summary");
const strategies = Object.keys(STRATEGIES);
console.log(`  ${"scenario".padEnd(24)}${strategies.map((s) => s.padEnd(26)).join("")}`);
for (const [title, row] of table) console.log(`  ${title.padEnd(24)}${strategies.map((s) => row[s].padEnd(26)).join("")}`);
console.log(`  ${"wasted retries".padEnd(24)}${strategies.map((s) => String(totals[s].wasted).padEnd(26)).join("")}`);
console.log(`  ${"total tool calls".padEnd(24)}${strategies.map((s) => String(totals[s].calls).padEnd(26)).join("")}`);

lab.section("Checks");
lab.check(wire.isError === true && JSON.parse(resultText(wire)).errorCategory === "business", "MCP result carries isError=true plus a categorised envelope");
const flaky = get("1 flaky order service");
lab.check(finalStatus(flaky) === "recovered" && flaky.attempts.length === 3, "transient timeouts recovered locally inside the subagent (2 retries, then success)");
const refund = get("2 refund over policy");
lab.check(
  refund.attempts.length === 1 && (refund.results[0].customerMessage ?? "").includes("supervisor"),
  "business rule: not retried, customerMessage available to explain it",
);
const malformed = get("3 malformed order id");
lab.check(
  finalStatus(malformed) === "input_fixed" && malformed.results[0].result?.order_id === "ORD-1002",
  "validation: input corrected from details (#1002 -> ORD-1002) instead of retried as-is",
);
const empty = get("4 search, no matches").results[0];
lab.check(empty.status === "ok" && empty.result?.matched === 0, "empty search is a successful query (matched 0), not an error");
lab.check(finalStatus(get("5 corporate refund")) === "escalate", "permission error escalated, not retried");
lab.check(
  report6.status === "partial" && report6.results[0].tool === "lookup_order" && report6.unresolved?.error?.errorCategory === "transient",
  "unresolvable outage propagated with partial results, attempts and the error category",
);
lab.check(
  totals["structured"].wasted === 0 && totals["generic+retry_all"].wasted > 0,
  `wasted retries: structured 0 vs generic+retry_all ${totals["generic+retry_all"].wasted}`,
);
lab.check(finalStatus(get("1 flaky order service", "generic+no_retry")) === "unresolved", "generic+no_retry avoids waste but gives up on a timeout it could have survived");
