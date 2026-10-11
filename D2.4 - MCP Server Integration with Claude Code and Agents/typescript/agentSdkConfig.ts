/**
 * D2.4 - Agent SDK: a stdio MCP server and an in-process SDK server in one agent.
 *
 * LAB_SKIP_AUTORUN - the query() part is live-only (it drives the Claude Code runtime).
 * Offline it builds the options, prints them, and calls the in-process tool's handler
 * function directly.
 *
 *   mcpServers = {
 *     "team-kb": { type: "stdio", command: "npx", args: ["tsx", "teamKbServer.ts", "--serve"], env },
 *     notes: createSdkMcpServer({ name: "notes", tools: [saveNote] }),   // runs in this process
 *   }
 *
 * Both servers' tools are discovered at connection time and offered together
 * (mcp__team-kb__*, mcp__notes__*). The init system message reports each server's status.
 *
 * Run:  npx tsx agentSdkConfig.ts          (offline: print config only)
 *       npx tsx agentSdkConfig.ts --live   (real agent run)
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as lab from "../../shared/typescript/labkit.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..", "example-project");
const PROMPT = "Who owns the payments service and what does its runbook say about restarts? Save a one-line note with the answer.";
const NOTES: string[] = [];

/** The in-process tool's logic, kept as a plain function so it can be called offline. */
async function saveNoteHandler(args: { text: string }) {
  NOTES.push(args.text);
  return { content: [{ type: "text" as const, text: JSON.stringify({ saved: true, count: NOTES.length }) }] };
}

const saveNote = tool(
  "save_note",
  "Append one line to this session's notes and return {saved, count}. Use it when the user asks you to keep or note an answer.",
  { text: z.string() },
  async (args) => saveNoteHandler(args),
);

const teamKb = {
  // Same server Claude Code starts from .mcp.json; here the SDK starts it as a subprocess.
  type: "stdio" as const,
  command: "npx",
  args: ["tsx", path.join(HERE, "teamKbServer.ts"), "--serve"],
  env: { KB_URL: process.env.KB_URL ?? "http://localhost:8080", KB_TOKEN: process.env.KB_TOKEN ?? "" },
};
const allowedTools = [
  "mcp__team-kb__find_service_owner",
  "mcp__team-kb__get_doc",
  "mcp__team-kb__search_kb",
  "mcp__notes__save_note",
  "Read",
  "Grep",
  "Glob",
];

lab.banner("D2.4  Agent SDK: stdio MCP server + in-process SDK MCP server");
lab.show("mcpServers", { "team-kb": teamKb, notes: { type: "sdk", name: "notes", instance: "<in-process MCP server>" } });
lab.show("allowedTools", allowedTools);

lab.section("In-process tool, called directly (no runtime needed)");
console.log(`  save_note -> ${JSON.stringify(await saveNoteHandler({ text: "offline smoke test" }))}`);
lab.check(teamKb.type === "stdio", "one stdio server and one in-process SDK server configured together");
lab.check(NOTES.length === 1 && NOTES[0] === "offline smoke test", "the SDK tool is ordinary TypeScript and ran in-process");

if (!lab.isLive()) {
  console.log("\nThe agent run needs the Claude Code runtime. Re-run with --live.");
} else {
  lab.section("Live agent run");
  const notes = createSdkMcpServer({ name: "notes", version: "1.0.0", tools: [saveNote] });
  let ok = false;
  for await (const m of query({
    prompt: PROMPT,
    options: {
      mcpServers: { "team-kb": teamKb, notes },
      allowedTools,
      disallowedTools: ["Bash", "Write", "Edit"],
      cwd: PROJECT,
      maxTurns: 8,
      model: lab.MODEL,
    },
  })) {
    if (m.type === "system" && m.subtype === "init") {
      // Shape follows the Claude Code init message: [{ name, status: "connected" | "failed" | ... }]
      const init = m as unknown as { mcp_servers?: unknown; tools?: string[] };
      console.log(`  MCP server status: ${JSON.stringify(init.mcp_servers)}`);
      console.log(`  MCP tools offered: ${JSON.stringify((init.tools ?? []).filter((t) => t.startsWith("mcp__")))}`);
    } else if (m.type === "assistant") {
      for (const block of m.message.content) if (block.type === "tool_use") console.log(`  tool_use ${block.name} ${JSON.stringify(block.input)}`);
    } else if (m.type === "result") {
      ok = m.subtype === "success";
      console.log(`  result (${m.subtype}): ${m.subtype === "success" ? m.result : ""}`);
    }
  }
  lab.check(ok, "agent finished using tools from both servers");
}
