/**
 * D5.4 - The delegation pattern with the Claude Agent SDK: an Explore-style subagent.
 *
 * The main agent gets one subagent definition, "explorer", restricted to the read-only
 * built-ins Read, Grep and Glob. Verbose discovery happens inside the subagent's own context;
 * only its summary comes back. The main agent needs "Agent" in allowedTools to spawn it
 * (the tool was renamed from "Task" in Claude Code v2.1.63; "Task" remains an alias).
 *
 * Offline this validates and prints the configuration. With --live it runs against the
 * fixture repo (requires the Claude Code runtime that the Agent SDK drives).
 *
 * Run:  npx tsx sdkExploreAgent.ts          (offline: configuration only)
 *       npx tsx sdkExploreAgent.ts --live   (real agent run)
 */
import { statSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { LAB_DIR, REPO } from "./explorer.ts";

const READ_ONLY = ["Read", "Grep", "Glob"];

const EXPLORER = {
  description:
    "Read-only codebase explorer. Use it for verbose discovery (finding files, tracing call chains) " +
    "so the main conversation only receives a concise summary.",
  prompt:
    "You explore a repository with Read, Grep and Glob only. Return a concise summary with exact class " +
    "names, file paths, constants and call order. Never paste whole files.",
  tools: ["Read", "Grep", "Glob"],
  model: "inherit" as const,
};

const OPTIONS = {
  cwd: REPO,
  agents: { explorer: EXPLORER },
  allowedTools: ["Read", "Grep", "Glob", "Agent"], // "Agent" spawns subagents
  disallowedTools: ["Write", "Edit", "Bash"],
  maxTurns: 20,
};

const PROMPT =
  "Use the explorer subagent twice, in parallel: (1) find all test files and what each covers; " +
  "(2) trace the refund flow starting from post_refund. Then give me a five-line summary with exact class names.";

async function runLive(): Promise<void> {
  for await (const message of query({ prompt: PROMPT, options: OPTIONS })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && (block.name === "Agent" || block.name === "Task")) {
          const input = block.input as { subagent_type?: string; description?: string };
          console.log(`  delegated to ${input.subagent_type ?? "?"}: ${(input.description ?? "").slice(0, 70)}`);
        }
      }
    } else if (message.type === "result") {
      console.log(`result (${message.subtype}, ${message.num_turns} turns):\n${message.subtype === "success" ? message.result : ""}`);
    }
  }
}

lab.banner("D5.4  Explore-style subagent with the Claude Agent SDK");
lab.section("Subagent definition");
lab.show("agents['explorer']", EXPLORER);
lab.section("Main agent options");
lab.show("options", {
  cwd: path.relative(LAB_DIR, OPTIONS.cwd).replaceAll("\\", "/"),
  allowed_tools: OPTIONS.allowedTools,
  disallowed_tools: OPTIONS.disallowedTools,
  max_turns: OPTIONS.maxTurns,
});

lab.section("Checks");
lab.check(EXPLORER.tools.every((t) => READ_ONLY.includes(t)), "the explorer subagent can only read (Read, Grep, Glob)");
lab.check(OPTIONS.allowedTools.includes("Agent"), "the main agent may spawn subagents ('Agent', formerly 'Task')");
lab.check(
  !OPTIONS.disallowedTools.some((t) => READ_ONLY.includes(t)) && OPTIONS.disallowedTools.includes("Write"),
  "nothing can write to the repo",
);
lab.check(statSync(OPTIONS.cwd).isDirectory(), "cwd points at the fixture repo");

if (lab.isLive()) {
  lab.section("Live run");
  await runLive();
} else {
  console.log("\noffline: configuration only. Re-run with --live to watch the delegation happen.");
}
