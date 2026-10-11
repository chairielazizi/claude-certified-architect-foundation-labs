/**
 * D1.5 - Unit-test the hooks offline by calling them exactly the way the SDK does.
 *
 *   1. Raw tool output: three backends, three date formats, two status vocabularies
 *   2. PostToolUse normalizer called directly with a realistic input object
 *   3. PreToolUse refund guard called directly: $750 denied, $500 and $120 allowed
 *   4. simulateToolCall(): PreToolUse -> handler -> PostToolUse, like the SDK
 *   5. Matcher scoping: which hook fires for which tool name
 *
 * Always offline: no model is involved, only hook callbacks and tool handlers.
 * Run:  npx tsx hookDemo.ts
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { contentText, matcherMatches, simulateToolCall, specOf } from "./harness.ts";
import { HOOKS, STATUS_ENUM, enforceRefundLimit, normalizeShopOutput } from "./hooks.ts";
import { ALLOWED_TOOLS, HANDLERS, REFUNDS, mcpName, resetLedgers } from "./shopServer.ts";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CONTEXT = { signal: new AbortController().signal } as Parameters<HookCallback>[2];

/** The input object the SDK hands a hook callback (fields per PreToolUseHookInput / PostToolUseHookInput). */
function hookInput(event: string, tool: string, toolInput: Record<string, unknown>, toolResponse?: unknown) {
  const data: Record<string, unknown> = {
    hook_event_name: event,
    session_id: "3f1c2d4e-demo",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: process.cwd(),
    tool_name: mcpName(tool),
    tool_input: toolInput,
    tool_use_id: "toolu_demo_01",
  };
  if (event === "PostToolUse") data.tool_response = toolResponse;
  return data as unknown as Parameters<HookCallback>[0];
}

const dateFields = (record: Record<string, unknown>) => Object.keys(record).filter((k) => k.endsWith("_at"));
const sameKeys = (a: object, b: object) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());

lab.banner("D1.5  Hooks unit-tested offline (normalization + refund guard)");
resetLedgers();

lab.section("1. Raw tool output from three systems");
const lookups: [string, string][] = [
  ["get_order_legacy", "ORD-1001"],
  ["get_order_v2", "ORD-2002"],
  ["get_shipment", "ORD-2002"],
];
const raw: Record<string, unknown> = {};
for (const [tool, orderId] of lookups) {
  const result = await HANDLERS[tool]({ order_id: orderId }); // the tool handler itself
  raw[tool] = result.content;
  console.log(`${tool}: ${contentText(result.content)}`);
}

lab.section("2. PostToolUse normalizer, called directly");
const canonical: Record<string, Record<string, unknown>> = {};
for (const [tool, orderId] of lookups) {
  const out = await normalizeShopOutput(hookInput("PostToolUse", tool, { order_id: orderId }, raw[tool]), "toolu_demo_01", CONTEXT);
  canonical[tool] = JSON.parse(contentText(specOf(out).updatedToolOutput)) as Record<string, unknown>;
  console.log(`${tool} ->\n  ${JSON.stringify(canonical[tool])}`);
}
const records = Object.values(canonical);
lab.check(records.every((r) => dateFields(r).every((k) => ISO_UTC.test(String(r[k])))), "every date is ISO 8601 UTC (YYYY-MM-DDTHH:MM:SSZ)");
lab.check(records.every((r) => STATUS_ENUM.includes(String(r.status))), `every status is in the canonical enum ${JSON.stringify(STATUS_ENUM.slice(0, 4))}...`);
lab.check(canonical.get_order_legacy.status === "delivered", "legacy numeric status 3 became 'delivered'");
lab.check(sameKeys(canonical.get_order_legacy, canonical.get_order_v2), "legacy and v2 orders now share one shape");
lab.check(canonical.get_order_v2.created_at === "2026-10-05T06:30:00Z", "v2 '+08:00' timestamp was converted to UTC");
lab.check(String(canonical.get_shipment.shipped_at).startsWith("2026-10-06"), "MM/DD/YYYY 10/06/2026 read as 6 October, not 10 June");
const errorOut = await normalizeShopOutput(
  hookInput("PostToolUse", "get_order_v2", { order_id: "ORD-9" }, [{ type: "text", text: '{"error": "No v2 order"}' }]),
  undefined,
  CONTEXT,
);
lab.check(Object.keys(errorOut).length === 0, "error results pass through untouched (hook returns {})");

lab.section("3. PreToolUse refund guard, called directly");
const decisions: Record<string, unknown> = {};
for (const amount of [750, 500, 120, "lots"]) {
  const out = await enforceRefundLimit(
    hookInput("PreToolUse", "process_refund", { order_id: "ORD-1001", amount, reason: "damaged" }),
    "toolu_demo_02",
    CONTEXT,
  );
  decisions[String(amount)] = out;
  const decision = specOf(out).permissionDecision ?? "no opinion -> allowedTools applies";
  console.log(`amount=${JSON.stringify(amount).padStart(7)}: ${String(decision)}`);
}
const deny = specOf(decisions["750"]);
console.log(`deny reason: ${String(deny.permissionDecisionReason)}`);
lab.check(deny.permissionDecision === "deny", "$750 refund is denied");
lab.check(String(deny.permissionDecisionReason).includes("escalate_to_human"), "the deny reason redirects the agent to escalate_to_human");
lab.check(
  Object.keys(decisions["500"] as object).length === 0 && Object.keys(decisions["120"] as object).length === 0,
  "$500 (at the limit) and $120 are allowed",
);
lab.check(specOf(decisions["lots"]).permissionDecision === "deny", "an unreadable amount fails closed");

lab.section("4. simulateToolCall: PreToolUse -> handler -> PostToolUse");
const big = await simulateToolCall("process_refund", { order_id: "ORD-1001", amount: 750, reason: "damaged" });
console.log(`process_refund $750: executed=${big.executed} trace=${JSON.stringify(big.trace)}`);
lab.check(!big.executed && REFUNDS.length === 0, "denied call never reached the handler (refund ledger still empty)");
const small = await simulateToolCall("process_refund", { order_id: "ORD-2002", amount: 120, reason: "late" });
console.log(`process_refund $120: executed=${small.executed} -> ${contentText(small.content)}`);
lab.check(small.executed && REFUNDS.length === 1, "allowed call ran the handler once");
const lookup = await simulateToolCall("get_order_legacy", { order_id: "ORD-1001" });
console.log(`get_order_legacy: trace=${JSON.stringify(lookup.trace)}`);
console.log(`  raw:  ${contentText(lookup.raw)}`);
console.log(`  seen: ${contentText(lookup.content)}`);
lab.check(
  (JSON.parse(contentText(lookup.content)) as Record<string, unknown>).status === "delivered",
  "the model receives the canonical record, not the raw one",
);

lab.section("5. Matcher scoping (matchers see the tool NAME only)");
for (const full of ALLOWED_TOOLS) {
  const fired = Object.entries(HOOKS).flatMap(([event, ms]) => ms.filter((m) => matcherMatches(m.matcher, full)).map((m) => `${event}[${m.matcher}]`));
  console.log(`  ${full.padEnd(32)} ${fired.length ? JSON.stringify(fired) : "-"}`);
}
const getTools = ALLOWED_TOOLS.filter((t) => matcherMatches("^mcp__shop__get_", t));
lab.check(getTools.length === 3 && !getTools.includes(mcpName("process_refund")), "the PostToolUse regex catches exactly the three get_ tools");
