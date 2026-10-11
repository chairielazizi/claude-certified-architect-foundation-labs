/**
 * D1.1 - A correct agentic loop, driven by stop_reason.
 *
 *   request -> inspect stop_reason
 *       "tool_use" -> run every requested tool -> append results -> request again
 *       "end_turn" -> done: present the final answer
 *
 * Run:  npx tsx agenticLoop.ts          (offline, scripted model turns)
 *       npx tsx agenticLoop.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { SYSTEM_PROMPT, TOOLS, executeTool, scriptedModel } from "./supportBackend.ts";

// A runaway guard, NOT the stopping mechanism. Hitting it is a bug to investigate,
// so it throws instead of quietly returning a half-finished answer.
const SAFETY_MAX_ITERATIONS = 25;

export async function runAgent(
  client: lab.MessagesClient,
  userRequest: string,
): Promise<{ answer: string; history: Anthropic.MessageParam[] }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userRequest }];

  for (let iteration = 1; iteration <= SAFETY_MAX_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    console.log(`  iteration ${iteration}: stop_reason=${response.stop_reason}`);

    // Append the FULL assistant content (text, tool_use and any thinking blocks) so the
    // next request carries the model's own prior reasoning and tool calls.
    messages.push({ role: "assistant", content: response.content });

    switch (response.stop_reason) {
      case "tool_use": {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of lab.toolUses(response)) {
          const [content, isError] = executeTool(block.name, block.input as Record<string, unknown>);
          console.log(`    ran ${block.name}(${JSON.stringify(block.input)}) -> ${content}`);
          // is_error lets the model see and reason about failures.
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
        }
        // Every result for this turn goes back in ONE user message, matched by tool_use_id.
        messages.push({ role: "user", content: toolResults });
        continue;
      }
      case "end_turn":
        return { answer: lab.textOf(response), history: messages };
      case "pause_turn":
        // A server-side tool paused a long turn; re-send so the model can resume it.
        continue;
      case "max_tokens":
        throw new Error("Response truncated at max_tokens; raise max_tokens and retry");
      case "refusal":
        return { answer: "The request was declined.", history: messages };
      default:
        throw new Error(`Unexpected stop_reason ${response.stop_reason}`);
    }
  }
  throw new Error(`Loop did not converge in ${SAFETY_MAX_ITERATIONS} iterations`);
}

function toolNames(content: Anthropic.MessageParam["content"]): string[] {
  if (typeof content === "string") return [];
  return content.flatMap((b) => (b.type === "tool_use" ? [b.name] : []));
}

async function main(): Promise<void> {
  lab.banner("D1.1  Agentic loop controlled by stop_reason");

  const scenarios: Record<string, string> = {
    "A - customer identifies by email": "Hi, I'm alice@example.com. Has my order arrived?",
    "B - customer gives the order ID": "Where is order ORD-5521?",
  };

  for (const [title, request] of Object.entries(scenarios)) {
    lab.section(title);
    console.log(`user: ${request}`);
    const { answer, history } = await runAgent(lab.getClient(scriptedModel), request);
    console.log(`assistant: ${answer}`);

    const toolTurns = history.filter((m) => m.role === "assistant" && toolNames(m.content).length > 0);
    const resultTurns = history.slice(1).filter((m) => m.role === "user");
    const toolsCalled = toolTurns.flatMap((m) => toolNames(m.content));
    console.log(`  tools the model chose, in order: ${JSON.stringify(toolsCalled)}`);

    const failed = resultTurns.flatMap((m) =>
      typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result" && b.is_error),
    );
    lab.check(history[history.length - 1].role === "assistant", "loop ended on the end_turn assistant message");
    lab.check(resultTurns.length === toolTurns.length, "each tool_use turn was answered by one user turn of tool_results");
    lab.check(failed.length === 0, "every tool call succeeded");
    if (!lab.isLive() && title.startsWith("B")) {
      lab.check(JSON.stringify(toolsCalled) === '["lookup_order"]', "model skipped get_customer because the order ID was given");
    }
  }
}

// Run main() only when executed directly (antiPatterns.ts imports runAgent).
if (lab.isMain(import.meta.url)) {
  await main();
}
