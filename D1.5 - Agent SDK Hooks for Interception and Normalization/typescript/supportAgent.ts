/**
 * D1.5 - A support agent whose tool calls pass through hooks.
 *
 * The customer wants a full refund for a $750 legacy order. The system prompt says nothing about
 * limits, so the agent tries process_refund($750). The PreToolUse hook denies it with a reason
 * naming escalate_to_human, and the agent escalates. Along the way the PostToolUse hook turns
 * the legacy order (epoch seconds, status 3, cents) into the canonical record.
 *
 *   live:     query() with hooks, mcpServers: { shop }, allowedTools
 *   offline:  the same hooks and handlers, driven by a scripted model through
 *             harness.runOfflineAgent / simulateToolCall
 *
 * Run:  npx tsx supportAgent.ts          (offline)
 *       npx tsx supportAgent.ts --live   (Agent SDK + real Claude; costs tokens)
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { type AgentCall, contentText, runOfflineAgent, simulateToolCall } from "./harness.ts";
import { HOOK_EVENTS, HOOKS, REFUND_LIMIT_USD } from "./hooks.ts";
import { makeSupportModel } from "./scriptedModel.ts";
import { ALLOWED_TOOLS, ESCALATIONS, REFUNDS, buildShopServer, resetLedgers } from "./shopServer.ts";

// Deliberately no refund limit in the prompt: the business rule lives in the hook.
const SYSTEM_PROMPT =
  "You are a customer support agent for an online store. Use the shop tools to look up orders " +
  "before acting. Order IDs ORD-1xxx live in the legacy system, ORD-2xxx in v2. Be concise.";
const REQUEST = "Order ORD-1001 arrived damaged. Please refund the customer the full order total.";

async function runLive(): Promise<void> {
  const options = {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers: { shop: buildShopServer() }, // in-process SDK MCP server
    allowedTools: ALLOWED_TOOLS, // auto-approve the shop tools; hooks still run first
    tools: [] as string[], // no built-in tools (Bash, Read, ...): this agent only talks to the shop
    hooks: HOOKS,
    maxTurns: 12,
    model: lab.MODEL,
  };
  for await (const message of query({ prompt: REQUEST, options })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") console.log(`  tool_use ${block.name}(${JSON.stringify(block.input)})`);
        else if (block.type === "text" && block.text.trim()) console.log(`  assistant: ${block.text.trim()}`);
      }
    } else if (message.type === "result") {
      const answer = message.subtype === "success" ? message.result : "";
      console.log(`  result (${message.subtype}, ${message.num_turns} turns, $${message.total_cost_usd.toFixed(4)}): ${answer}`);
      const denials = (message as unknown as { permission_denials?: unknown[] }).permission_denials ?? [];
      if (denials.length) lab.show("  permission_denials", denials);
    }
  }
}

async function runOffline(): Promise<AgentCall[]> {
  const client = new lab.ScriptedClient(makeSupportModel());
  const { answer, calls } = await runOfflineAgent(client, SYSTEM_PROMPT, REQUEST, simulateToolCall);
  for (const call of calls) {
    const status = call.outcome.executed ? "EXECUTED" : "DENIED by PreToolUse";
    console.log(`  tool_use ${call.name}(${JSON.stringify(call.input)}) -> ${status}`);
    for (const step of call.outcome.trace) console.log(`      ${step}`);
    console.log(`      model sees: ${contentText(call.outcome.content).slice(0, 160)}`);
  }
  console.log(`  assistant: ${answer}`);
  return calls;
}

lab.banner("D1.5  Support agent with PreToolUse + PostToolUse hooks");
resetLedgers();
HOOK_EVENTS.length = 0;
console.log(`user: ${REQUEST}`);

lab.section("Agent run");
let calls: AgentCall[] = [];
if (lab.isLive()) await runLive();
else calls = await runOffline();

lab.section("What the hooks did");
for (const event of HOOK_EVENTS) console.log(`  ${JSON.stringify(event)}`);
lab.show("refund ledger", REFUNDS);
lab.show("escalations", ESCALATIONS);

// Deterministic in BOTH modes: whatever the model tried, no over-limit refund executed.
lab.check(REFUNDS.every((r) => r.amount <= REFUND_LIMIT_USD), "no refund above $500 was executed");
if (!lab.isLive()) {
  const names = calls.map((c) => c.name);
  lab.check(names[0] === "get_order_legacy", "agent looked the order up first");
  lab.check(HOOK_EVENTS.some((e) => e.hook === "PostToolUse" && e.action === "normalized"), "PostToolUse normalized the legacy record");
  lab.check(HOOK_EVENTS.some((e) => e.action === "deny"), "PreToolUse denied process_refund($750)");
  lab.check(
    names[names.length - 1] === "escalate_to_human" && ESCALATIONS[0].amount === 750,
    "the deny reason redirected the agent to escalate_to_human",
  );
}
