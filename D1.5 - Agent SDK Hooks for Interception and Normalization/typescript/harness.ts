/**
 * Offline stand-in for what the Agent SDK does around every tool call.
 *
 *   simulateToolCall(name, input):
 *       PreToolUse hooks (matching by tool name)  -> any "deny" wins, the handler never runs
 *       tool handler                              -> raw backend output
 *       PostToolUse hooks                         -> updatedToolOutput replaces what the model sees
 *
 *   runOfflineAgent(...): the agentic loop query() runs for you, driven by a scripted model,
 *   with every tool call routed through an executor (hooked or not).
 *
 * With the real SDK you never write this: you pass hooks and mcpServers to query() and Claude
 * Code applies them. Writing it once makes the order of operations, and the "deny means the
 * handler does not run" guarantee, explicit and testable.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { HOOKS, isRecord } from "./hooks.ts";
import { API_TOOL_DEFS, HANDLERS, mcpName, shortName } from "./shopServer.ts";

export type HookConfig = Record<string, { matcher?: string; hooks: HookCallback[] }[]>;
type HookInputArg = Parameters<HookCallback>[0];
type HookOptionsArg = Parameters<HookCallback>[2];

export interface SimulatedCall {
  executed: boolean;
  isError: boolean;
  content: unknown;
  raw?: unknown;
  trace: string[];
}

/** Approximates Claude Code's matcher rules: empty or "*" matches everything; a plain name
 * (letters, digits, _ and |) is an exact match against |-separated names; anything else is a
 * regular expression tested against the tool name. */
export function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(toolName);
  return new RegExp(matcher).test(toolName);
}

/** The text the model would read from a tool result. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks: unknown = isRecord(content) ? content.content : content;
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => (isRecord(b) && b.type === "text" ? String(b.text ?? "") : "")).join("");
}

/** hookSpecificOutput of a hook's return value ({} when the hook had no opinion). */
export function specOf(out: unknown): Record<string, unknown> {
  const o = out as { hookSpecificOutput?: Record<string, unknown> };
  return o.hookSpecificOutput ?? {};
}

export async function simulateToolCall(
  name: string,
  toolInput: Record<string, unknown>,
  toolUseId = "toolu_offline",
  hooks: HookConfig = HOOKS,
): Promise<SimulatedCall> {
  const fullName = name.startsWith("mcp__") ? name : mcpName(name);
  const base = {
    session_id: "offline-session",
    transcript_path: "",
    cwd: process.cwd(),
    tool_name: fullName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
  const options = { signal: new AbortController().signal } as HookOptionsArg;
  const trace: string[] = [];

  // 1) PreToolUse: every matching hook runs; one "deny" beats any number of "allow"s.
  let denyReason: string | null = null;
  for (const m of hooks.PreToolUse ?? []) {
    if (!matcherMatches(m.matcher, fullName)) continue;
    for (const callback of m.hooks) {
      const hookInput = { ...base, tool_input: toolInput, hook_event_name: "PreToolUse" };
      const spec = specOf(await callback(hookInput as unknown as HookInputArg, toolUseId, options));
      const decision = String(spec.permissionDecision ?? "none");
      trace.push(`PreToolUse[${m.matcher}] -> ${decision}`);
      if (decision === "deny" && denyReason === null) {
        denyReason = String(spec.permissionDecisionReason ?? "Denied by hook");
      }
      if (isRecord(spec.updatedInput)) toolInput = spec.updatedInput; // a hook may rewrite the arguments
    }
  }
  if (denyReason !== null) {
    // The handler never runs. The model receives the reason as an error tool result.
    return { executed: false, isError: true, content: [{ type: "text", text: denyReason }], trace };
  }

  // 2) The tool itself.
  const result = await HANDLERS[shortName(fullName)](toolInput);
  const rawContent = result.content;
  trace.push(`handler ${shortName(fullName)} ran`);

  // 3) PostToolUse: a hook can replace the output before the model processes it.
  let content: unknown = rawContent;
  for (const m of hooks.PostToolUse ?? []) {
    if (!matcherMatches(m.matcher, fullName)) continue;
    for (const callback of m.hooks) {
      const postInput = { ...base, tool_input: toolInput, hook_event_name: "PostToolUse", tool_response: rawContent };
      const spec = specOf(await callback(postInput as unknown as HookInputArg, toolUseId, options));
      if ("updatedToolOutput" in spec) {
        content = spec.updatedToolOutput;
        trace.push(`PostToolUse[${m.matcher}] -> replaced output`);
      }
    }
  }
  return { executed: true, isError: Boolean(result.isError), content, raw: rawContent, trace };
}

/** The same call with no hooks registered: raw output, no policy check. */
export function runToolUnhooked(name: string, toolInput: Record<string, unknown>, toolUseId = "toolu_offline") {
  return simulateToolCall(name, toolInput, toolUseId, {});
}

export type Executor = (name: string, input: Record<string, unknown>, toolUseId: string) => Promise<SimulatedCall>;

export interface AgentCall {
  name: string;
  input: Record<string, unknown>;
  outcome: SimulatedCall;
}

/** A stop_reason-driven loop (see D1.1) whose tool calls go through `executor`. */
export async function runOfflineAgent(
  client: lab.MessagesClient,
  system: string,
  request: string,
  executor: Executor,
  maxIterations = 10,
): Promise<{ answer: string; calls: AgentCall[] }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: request }];
  const calls: AgentCall[] = [];
  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 16000,
      system,
      tools: API_TOOL_DEFS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return { answer: lab.textOf(response), calls };
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of lab.toolUses(response)) {
      const input = block.input as Record<string, unknown>;
      const outcome = await executor(block.name, input, block.id);
      calls.push({ name: shortName(block.name), input, outcome });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: contentText(outcome.content),
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error(`Agent did not finish in ${maxIterations} iterations`);
}
