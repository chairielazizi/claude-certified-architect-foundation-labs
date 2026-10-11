/**
 * Offline stand-in for Claude in the D1.5 demos.
 *
 * It is model-driven: it reads the request, the system prompt and the tool results to pick its
 * next action. Two behaviours matter for the lab:
 *  - It follows a refund limit written in the system prompt *most* of the time. With
 *    probability VIOLATION_RATE (decided by `complianceDraw`) it refunds anyway, which is how
 *    prompt-only compliance fails in production: rarely, unpredictably, never zero.
 *  - When a tool result tells it to escalate (the hook's deny reason), it does.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { isRecord } from "./hooks.ts";
import { mcpName, shortName } from "./shopServer.ts";

/** Share of over-limit requests where the prompt-only model ignores the rule. Real rates vary
 * by model, prompt and conversation length; the point is that they are not zero. */
export const VIOLATION_RATE = 0.06;

/** Every tool_result so far, oldest first (the model sees the whole conversation). */
function allResults(params: lab.CreateParams): Anthropic.ToolResultBlockParam[] {
  const found: Anthropic.ToolResultBlockParam[] = [];
  for (const msg of params.messages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content) if (block.type === "tool_result") found.push(block);
  }
  return found;
}

function jsonOrEmpty(result: Anthropic.ToolResultBlockParam): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(lab.toolResultText(result));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** complianceDraw in [0, 1): below VIOLATION_RATE the model ignores a prompt-stated limit. */
export function makeSupportModel(complianceDraw = 1): lab.Responder {
  return (params) => {
    const first = params.messages[0].content;
    const request = typeof first === "string" ? first : "";
    const system = lab.systemText(params);
    const called = lab.allToolCalls(params).map((n) => shortName(n));
    const results = allResults(params);
    const last = results.length ? results[results.length - 1] : undefined;
    const lastText = last ? lab.toolResultText(last) : "";

    const orderId = (request.match(/ORD-\d+/) ?? ["ORD-0000"])[0];
    const stated = request.match(/\$(\d+(?:\.\d+)?)/);

    // 1) No amount in the request: look the order up (legacy IDs are ORD-1xxx).
    if (!stated && !called.some((c) => c.startsWith("get_order"))) {
      const lookup = orderId.startsWith("ORD-1") ? "get_order_legacy" : "get_order_v2";
      return lab.message([lab.text("Let me look up the order first."), lab.toolUse(mcpName(lookup), { order_id: orderId })]);
    }

    let amount: number;
    if (stated) {
      amount = Number(stated[1]);
    } else {
      // Relies on the canonical fields the PostToolUse hook guarantees ("total" in dollars).
      const orders = results.map(jsonOrEmpty).filter((p) => p.record_type === "order");
      amount = orders.length ? Number(orders[0].total ?? 0) : 0;
    }

    const escalate = lab.toolUse(mcpName("escalate_to_human"), {
      order_id: orderId,
      amount,
      summary: `Customer requests $${amount.toFixed(2)} refund for ${orderId} (damaged item).`,
    });

    // 2) A denial that names the alternative workflow: follow it.
    if (last && last.is_error && lastText.includes("escalate_to_human") && !called.includes("escalate_to_human")) {
      return lab.message([lab.text("That refund needs human approval, so I'm escalating it."), escalate]);
    }

    // 3) First action on the refund itself.
    if (!called.includes("process_refund") && !called.includes("escalate_to_human")) {
      const promptHasLimit = system.includes("$500");
      if (promptHasLimit && amount > 500 && complianceDraw >= VIOLATION_RATE) {
        return lab.message([lab.text("This is above my refund limit, so I'll escalate."), escalate]);
      }
      const refund = lab.toolUse(mcpName("process_refund"), { order_id: orderId, amount, reason: "damaged item" });
      return lab.message([lab.text(`Processing a $${amount.toFixed(2)} refund.`), refund]);
    }

    // 4) Report the outcome.
    const payload = last ? jsonOrEmpty(last) : {};
    if ("ticket_id" in payload) {
      return lab.message([
        lab.text(
          `I can't approve $${amount.toFixed(2)} myself, so I've escalated ${orderId} to a human agent (ticket ${String(payload.ticket_id)}).`,
        ),
      ]);
    }
    if ("refund_id" in payload) {
      return lab.message([lab.text(`Refunded $${amount.toFixed(2)} for ${orderId} (refund ${String(payload.refund_id)}).`)]);
    }
    return lab.message([lab.text(`I couldn't complete the refund for ${orderId}: ${lastText}`)]);
  };
}
