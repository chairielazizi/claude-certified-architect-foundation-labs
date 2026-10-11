/**
 * D2.5 - A read-only exploration agent with the Agent SDK (Read, Grep, Glob only).
 *
 * LAB_SKIP_AUTORUN - the query() part is live-only (it drives the Claude Code runtime).
 * Offline it prints the options and the prompt.
 *
 *   query({ prompt, options: { tools: ["Read", "Grep", "Glob"], allowedTools: [...same...], cwd: sample_repo } })
 *
 * `tools` restricts which built-in tools exist at all (no Write/Edit/Bash), and `allowedTools`
 * auto-approves the ones that remain. The prompt asks for the incremental strategy: Grep for
 * entry points and call sites, Read only what is on the path, and resolve re-exports/aliases.
 *
 * Run:  npx tsx exploreAgent.ts          (offline: print config only)
 *       npx tsx exploreAgent.ts --live   (real agent run)
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";
import { Workspace } from "./miniTools.ts";

const SAMPLE_REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample_repo");
const READ_ONLY = ["Read", "Grep", "Glob"];

const PROMPT =
  "Where is the card actually charged when the app checks out a cart, and which other code " +
  "paths move money through the same function? Work incrementally: Grep for the entry point " +
  "and for call sites, Read only files on the path, and follow imports including re-exports " +
  "in __init__.py and 'import X as Y' aliases. Do not read every file. Answer with the chain " +
  "of file:function hops and the list of callers.";

lab.banner("D2.5  Read-only exploration agent (Agent SDK: Read, Grep, Glob)");
lab.show("options", { tools: READ_ONLY, allowedTools: READ_ONLY, cwd: "sample_repo/", maxTurns: 15 });
console.log(`prompt: ${PROMPT}`);
lab.check(!READ_ONLY.some((t) => ["Write", "Edit", "Bash"].includes(t)), "agent cannot modify files or run commands");

if (!lab.isLive()) {
  console.log("\nThe agent run needs the Claude Code runtime. Re-run with --live.");
} else {
  const used: Record<string, number> = {};
  let ok = false;
  for await (const m of query({
    prompt: PROMPT,
    options: { tools: READ_ONLY, allowedTools: READ_ONLY, cwd: SAMPLE_REPO, maxTurns: 15, model: lab.MODEL },
  })) {
    if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "tool_use") {
          used[block.name] = (used[block.name] ?? 0) + 1;
          console.log(`  ${block.name} ${JSON.stringify(block.input)}`);
        }
      }
    } else if (m.type === "result") {
      ok = m.subtype === "success";
      console.log(`\nresult (${m.subtype}, ${m.num_turns} turns):\n${m.subtype === "success" ? m.result : ""}`);
    }
  }
  const total = new Workspace(SAMPLE_REPO).allFiles().length;
  console.log(`\ntool usage: ${JSON.stringify(used)}; Read calls ${used.Read ?? 0} vs ${total} files in the repo`);
  lab.check(ok, "exploration finished");
  lab.check(Object.keys(used).every((t) => READ_ONLY.includes(t)), "only read-only tools were used");
}
