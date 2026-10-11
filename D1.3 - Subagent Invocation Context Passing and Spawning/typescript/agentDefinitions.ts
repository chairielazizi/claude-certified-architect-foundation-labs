/**
 * D1.3 - The coordinator's Agent SDK options and its three subagent definitions.
 *
 * Everything a subagent is lives in its AgentDefinition:
 *   description - what the coordinator reads to decide WHEN to delegate to it
 *   prompt      - the subagent's system prompt (it gets nothing else from the parent)
 *   tools       - least-privilege tool list for that role
 *   model       - "inherit" = same model as the coordinator
 *
 * The coordinator spawns subagents with the "Agent" tool. The exam guide calls it "Task": it was
 * renamed in Claude Code v2.1.63 and "Task" still works as an alias. Without it in allowedTools
 * the coordinator cannot delegate at all.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, Options } from "@anthropic-ai/claude-agent-sdk";
import * as lab from "../../shared/typescript/labkit.ts";

/** The doc-analyst reads ./docs relative to this directory (the agent's cwd). */
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export const TOPIC = "How is generative AI changing music licensing and visual-effects work?";

/** Names the spawning tool can appear under in a message stream. */
export const DELEGATION_TOOL_NAMES = ["Agent", "Task"];
export const isDelegation = (toolName: string): boolean => DELEGATION_TOOL_NAMES.includes(toolName);

/** The sentence that tells the coordinator to fan out (parallelSpawning.ts swaps it out). */
export const PARALLEL_SENTENCE =
  "Independent research can run at the same time: issue those Agent calls together in one response.";

// Goals and quality criteria, not a procedure: the coordinator decides HOW to meet them, so it
// can adapt (skip a source that has nothing, add a follow-up, run work in parallel).
export const COORDINATOR_PROMPT = `You lead a small research team and own the quality of its final briefing.

Research goal: a cited briefing on the user's topic that an analyst can rely on without re-checking.

Quality criteria:
- Every claim carries its source: a URL or a document name and page, plus a publication date.
- Coverage spans every major sub-area of the topic, not just the most visible one.
- Where sources disagree, report both figures with their sources instead of picking one.
- Separate well-established findings from contested or single-source ones.

Your team (spawn them with the Agent tool):
- web-researcher: current news and web sources.
- doc-analyst: the reports in ./docs.
- synthesizer: turns collected findings into the briefing.

Subagents start with an empty context: they cannot see this conversation or each other's work.
Put everything a subagent needs into its prompt, and give the synthesizer the complete findings as
JSON with content and source metadata in separate fields.
${PARALLEL_SENTENCE}`;

/** Anti-pattern for comparison: a step list leaves nothing to judge and hard-codes one document. */
export const PROCEDURAL_PROMPT = `Step 1: Ask web-researcher to search for the topic.
Step 2: Ask doc-analyst to read docs/music_rights_review_2026.md.
Step 3: Ask synthesizer to write a summary of what they said.
Step 4: Return the summary.`;

const FINDING_FORMAT =
  "Return a JSON list of findings. Each item: " +
  '{"finding_id": str, "content": {"claim": str, "evidence": str}, ' +
  '"metadata": {"source_url": str|null, "document_name": str|null, "page": int|null, "publication_date": str}}. ' +
  "Never return a claim without its source.";

export interface AgentSpec {
  description: string;
  prompt: string;
  tools: string[];
}

export const AGENT_SPECS: Record<string, AgentSpec> = {
  "web-researcher": {
    description:
      "Finds current news and web sources for one narrowly scoped research question. " +
      "Use for recent deals, announcements and published statistics.",
    prompt: "You are a web researcher. Answer only the question in your task, using web search. " + FINDING_FORMAT,
    tools: ["WebSearch", "WebFetch"],
  },
  "doc-analyst": {
    description:
      "Extracts findings, with page numbers, from the report library in ./docs. " +
      "Use when a question can be answered from those reports.",
    prompt: "You are a document analyst. Read only the reports in ./docs that bear on your task. " + FINDING_FORMAT,
    tools: ["Read", "Grep", "Glob"],
  },
  synthesizer: {
    description:
      "Writes the cited briefing from findings passed to it. Does no research of its own: " +
      "its prompt must contain the complete findings.",
    prompt:
      "You are a research synthesizer. Work only from the findings in your prompt. Cite every claim with " +
      "its finding_id and source. When findings conflict, keep both values side by side with their sources.",
    // No web tools: it must not go off and re-research (least privilege, sample question 9).
    tools: ["Read"],
  },
};

/** Numbered procedural steps in a prompt (used to lint coordinator prompts). */
export function stepsIn(prompt: string): string[] {
  return prompt.match(/^\s*step\s+\d+/gim) ?? [];
}

/** Agent SDK options for the coordinator. */
export function buildOptions(): Options {
  const agents: Record<string, AgentDefinition> = {};
  for (const [name, spec] of Object.entries(AGENT_SPECS)) {
    agents[name] = { description: spec.description, prompt: spec.prompt, tools: spec.tools, model: "inherit" };
  }
  return {
    systemPrompt: COORDINATOR_PROMPT,
    agents,
    // "Agent" lets the coordinator spawn subagents (exam: "Task"). The research tools are
    // pre-approved so the subagents that are ALLOWED them (per AgentDefinition.tools) are not
    // stopped by permission prompts. Nothing here can write or execute.
    allowedTools: ["Agent", "WebSearch", "WebFetch", "Read", "Grep", "Glob"],
    disallowedTools: ["Bash", "Write", "Edit"],
    model: lab.MODEL,
    cwd: FIXTURES,
    maxTurns: 40,
  };
}
