/**
 * Customer-support backend shared by the D1.1 demos: tool definitions, tool execution,
 * and a model-driven scripted model for offline runs (it decides each turn from what is
 * already in the conversation, the same way Claude does).
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

export const SYSTEM_PROMPT =
  "You are a customer support agent for an online electronics store. " +
  "Use the tools to look up real data before answering; never guess order details. " +
  "When you have what you need, answer the customer concisely.";

const CUSTOMERS: Record<string, { customer_id: string; name: string; tier: string }> = {
  "alice@example.com": { customer_id: "C-1001", name: "Alice Tan", tier: "gold" },
};

interface Order {
  order_id: string;
  customer_id: string;
  status: string;
  delivered_on: string;
  items: string[];
  total: number;
}

const ORDERS: Record<string, Order> = {
  "ORD-5521": {
    order_id: "ORD-5521",
    customer_id: "C-1001",
    status: "delivered",
    delivered_on: "2026-10-02",
    items: ["Wireless headphones"],
    total: 89.9,
  },
};

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_customer",
    description:
      "Look up a customer account by email address. Returns customer_id, name and tier. " +
      "Use this when the customer identifies themselves by email or when you need their " +
      "customer_id. Does not return order information - use lookup_order for that.",
    input_schema: {
      type: "object",
      properties: { email: { type: "string", description: "Customer email, e.g. alice@example.com" } },
      required: ["email"],
    },
  },
  {
    name: "lookup_order",
    description:
      "Fetch a single order by its order ID (format ORD-####). Returns status, delivery date, " +
      "items and total. Use this for any question about a specific order. Does not look up " +
      "customers - use get_customer for account questions.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string", description: "Order ID, e.g. ORD-5521" } },
      required: ["order_id"],
    },
  },
];

/** Run a tool and return [jsonContent, isError]. */
export function executeTool(name: string, input: Record<string, unknown>): [string, boolean] {
  if (name === "get_customer") {
    const customer = CUSTOMERS[String(input.email ?? "").toLowerCase()];
    return customer ? [JSON.stringify(customer), false] : [JSON.stringify({ error: "No customer with that email" }), true];
  }
  if (name === "lookup_order") {
    const order = ORDERS[String(input.order_id ?? "").toUpperCase()];
    return order ? [JSON.stringify(order), false] : [JSON.stringify({ error: "No order with that ID" }), true];
  }
  return [JSON.stringify({ error: `Unknown tool ${name}` }), true];
}

/** Offline stand-in for Claude: decides the next turn from the conversation so far. */
export function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const first = params.messages[0].content;
  const firstRequest = typeof first === "string" ? first : "";
  const called = lab.allToolCalls(params);
  const results = lab.toolResults(params).map((r) => JSON.parse(lab.toolResultText(r)));

  const email = firstRequest.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  const orderId = firstRequest.match(/ORD-\d+/);

  // The customer gave an email but no order number: identify them first.
  if (email && !called.includes("get_customer")) {
    return lab.message([lab.text("Let me pull up your account first."), lab.toolUse("get_customer", { email: email[0] })]);
  }
  // We know which order is meant (stated directly, or it is the customer's latest).
  if (!called.includes("lookup_order")) {
    const target = orderId ? orderId[0] : "ORD-5521";
    return lab.message([lab.text("Now I'll check the order."), lab.toolUse("lookup_order", { order_id: target })]);
  }
  const order = results[results.length - 1] as Order;
  return lab.message([
    lab.text(
      `Your order ${order.order_id} (${order.items.join(", ")}) was delivered on ` +
        `${order.delivered_on}. Total charged: $${order.total.toFixed(2)}.`,
    ),
  ]);
}
