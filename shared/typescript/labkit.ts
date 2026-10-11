/**
 * Shared helpers used by every TypeScript lab in this repo.
 *
 * Every lab runs in one of two modes:
 *  - offline (default): a scripted client stands in for `new Anthropic()` and replays
 *    deterministic, hand-written model turns, so you can step through the
 *    architecture pattern with no API key and no cost.
 *  - live: pass `--live` (or set LAB_LIVE=1) and the lab calls the real Claude API
 *    through the official `@anthropic-ai/sdk`.
 *
 * Import from a lab with:
 *   import * as lab from "../../shared/typescript/labkit.ts";
 */
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Default model for live runs. */
export const MODEL = process.env.LAB_MODEL ?? "claude-opus-5-5";

/**
 * claude-opus-5-5, claude-sonnet-5-5 and claude-fable-5-1 reject forced tool use
 * (tool_choice {type: "any"} / {type: "tool"}) with HTTP 400. The exam still tests those
 * options, so labs that demonstrate them use a model that accepts them.
 */
export const FORCED_TOOL_CHOICE_MODEL = process.env.LAB_FORCED_TOOL_MODEL ?? "claude-opus-5";

export function isLive(): boolean {
  return process.argv.includes("--live") || process.env.LAB_LIVE === "1";
}

/** True when the module at `metaUrl` (pass import.meta.url) is the script being run. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = path.resolve(fileURLToPath(metaUrl));
  const run = path.resolve(entry);
  return process.platform === "win32" ? self.toLowerCase() === run.toLowerCase() : self === run;
}

// ---------------------------------------------------------------------------
// Scripted (offline) responses
// ---------------------------------------------------------------------------

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${String(++counter).padStart(4, "0")}`;

export type CreateParams = Anthropic.MessageCreateParamsNonStreaming;
export type Responder = (params: CreateParams) => Anthropic.Message | Promise<Anthropic.Message>;

/** The one method every lab needs; satisfied by both the real SDK and the scripted client. */
export interface MessagesClient {
  messages: { create(params: CreateParams): Promise<Anthropic.Message> };
}

export function text(value: string): Anthropic.TextBlock {
  return { type: "text", text: value, citations: null } as unknown as Anthropic.TextBlock;
}

export function toolUse(name: string, input: Record<string, unknown>, id?: string): Anthropic.ToolUseBlock {
  return { type: "tool_use", id: id ?? nextId("toolu"), name, input } as unknown as Anthropic.ToolUseBlock;
}

/** A scripted assistant Message; stop_reason defaults the way the real API behaves. */
export function message(content: Anthropic.ContentBlock[], stopReason?: Anthropic.Message["stop_reason"]): Anthropic.Message {
  const stop_reason = stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model: "scripted-offline",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

/** Responder that returns the given turns in order. */
export function sequence(...turns: Anthropic.Message[]): Responder {
  const queue = [...turns];
  return () => {
    const next = queue.shift();
    if (!next) throw new Error("Scripted conversation ran out of turns");
    return next;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ScriptedClient implements MessagesClient {
  readonly calls: CreateParams[] = [];
  readonly messages: MessagesClient["messages"];

  constructor(responder: Responder, latencyMs = 0) {
    this.messages = {
      create: async (params: CreateParams) => {
        this.calls.push(params);
        if (latencyMs) await sleep(latencyMs); // simulate network + generation time
        return responder(params);
      },
    };
  }
}

/** Real SDK client in live mode, otherwise a ScriptedClient. */
export function getClient(responder?: Responder, latencyMs = 0): MessagesClient {
  if (isLive()) {
    const real = new Anthropic();
    return { messages: { create: (params: CreateParams) => real.messages.create(params) } };
  }
  if (!responder) {
    console.log("This lab step only runs live. Re-run with --live.");
    process.exit(0);
  }
  return new ScriptedClient(responder, latencyMs);
}

/** The raw SDK client, for APIs beyond messages.create (e.g. Message Batches). Live mode only. */
export function getRawClient(): Anthropic {
  return new Anthropic();
}

// ---------------------------------------------------------------------------
// Helpers for reading request params inside responders, and responses in labs
// ---------------------------------------------------------------------------

export function systemText(params: CreateParams): string {
  const system = params.system ?? "";
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n");
}

export function lastUserBlocks(params: CreateParams): Anthropic.ContentBlockParam[] {
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const msg = params.messages[i];
    if (msg.role === "user") {
      return typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [...msg.content];
    }
  }
  return [];
}

export function lastUserText(params: CreateParams): string {
  return lastUserBlocks(params)
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function toolResults(params: CreateParams): Anthropic.ToolResultBlockParam[] {
  return lastUserBlocks(params).filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
}

/** Names of every tool the assistant has called so far in this conversation. */
export function allToolCalls(params: CreateParams): string[] {
  const names: string[] = [];
  for (const msg of params.messages) {
    if (msg.role === "assistant" && typeof msg.content !== "string") {
      for (const block of msg.content) if (block.type === "tool_use") names.push(block.name);
    }
  }
  return names;
}

/** Text content of a tool_result block (string or text sub-blocks). */
export function toolResultText(result: Anthropic.ToolResultBlockParam): string {
  if (typeof result.content === "string") return result.content;
  return (result.content ?? [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

export function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function toolUses(response: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

export function banner(title: string): void {
  const line = "=".repeat(Math.max(60, title.length + 4));
  const mode = isLive() ? `LIVE (model ${MODEL})` : "OFFLINE (scripted model turns; pass --live for the real API)";
  console.log(`${line}\n  ${title}\n  mode: ${mode}\n${line}`);
}

export function section(title: string): void {
  console.log(`\n--- ${title} ${"-".repeat(Math.max(3, 56 - title.length))}`);
}

export function show(label: string, value: unknown): void {
  if (value !== null && typeof value === "object") {
    console.log(`${label}:\n${JSON.stringify(value, null, 2)}`);
  } else {
    console.log(`${label}: ${String(value)}`);
  }
}

/** Assert a lab invariant with a readable PASS/FAIL line (non-zero exit on failure). */
export function check(condition: boolean, msg: string): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${msg}`);
  if (!condition) process.exit(1);
}
