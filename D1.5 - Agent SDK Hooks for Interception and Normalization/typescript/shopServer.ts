/**
 * In-process "shop" MCP server shared by the D1.5 demos.
 *
 * Three backend systems that disagree about data formats (the situation the exam describes):
 *   get_order_legacy   Unix epoch seconds, numeric status codes (3 = delivered), cents
 *   get_order_v2       ISO 8601 with a local UTC offset, upper-case status strings
 *   get_shipment       US-style MM/DD/YYYY dates, free-text shipment state
 * plus two actions, process_refund and escalate_to_human.
 *
 * The tools return raw backend data on purpose. Normalization and the refund limit live in
 * hooks.ts. The refund backend has no limit at all, so the hook is the only guard.
 *
 * Handlers are plain exported functions so the offline demos can call them directly;
 * buildShopServer() wraps them with tool() + createSdkMcpServer() for the live run.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const SERVER_NAME = "shop";

/** MCP tool result. A type alias (not an interface) so it stays assignable to the SDK's CallToolResult. */
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type Args = Record<string, unknown>;

export interface LegacyOrder {
  ord_no: string;
  cust: string;
  created: number;
  last_update: number;
  status: number;
  total_cents: number;
  currency: string;
}
export interface V2Order {
  orderId: string;
  customerId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  total: { amount: number; currency: string };
}
export interface Shipment {
  order: string;
  carrier: string;
  tracking_no: string;
  ship_date: string;
  est_delivery: string;
  state: string;
}

// Legacy order system (pre-2026 migration): epoch seconds, numeric statuses, integer cents.
const LEGACY_ORDERS: Record<string, LegacyOrder> = {
  "ORD-1001": {
    ord_no: "ORD-1001",
    cust: "C-1001",
    created: 1790932500, // 2026-10-02T09:15:00Z
    last_update: 1791304800, // 2026-10-06T16:40:00Z
    status: 3, // 3 = delivered, but only the legacy team knows that
    total_cents: 75000,
    currency: "USD",
  },
};

// Current platform: ISO 8601 with the warehouse's local offset, upper-case statuses.
const V2_ORDERS: Record<string, V2Order> = {
  "ORD-2002": {
    orderId: "ORD-2002",
    customerId: "C-2002",
    createdAt: "2026-10-05T14:30:00+08:00",
    updatedAt: "2026-10-06T09:00:00+08:00",
    status: "SHIPPED",
    total: { amount: 129.99, currency: "USD" },
  },
};

// Carrier integration: MM/DD/YYYY. "10/06/2026" is 6 October; a model guessing could read 10 June.
const SHIPMENTS: Record<string, Shipment> = {
  "ORD-2002": {
    order: "ORD-2002",
    carrier: "UPS",
    tracking_no: "1Z999AA10123456784",
    ship_date: "10/06/2026",
    est_delivery: "10/09/2026",
    state: "In Transit",
  },
};

export interface Refund {
  refund_id: string;
  order_id: string;
  amount: number;
  status: string;
}
export interface Ticket {
  ticket_id: string;
  order_id: string;
  amount: number;
  summary: string;
  queue: string;
}

// Side-effect ledgers. Tools run in-process, so the demos (and live checks) can inspect them.
export const REFUNDS: Refund[] = [];
export const ESCALATIONS: Ticket[] = [];

export function resetLedgers(): void {
  REFUNDS.length = 0;
  ESCALATIONS.length = 0;
}

const ok = (payload: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});
const orderIdOf = (args: Args) => String(args.order_id ?? "").toUpperCase();

export async function getOrderLegacy(args: Args): Promise<ToolResult> {
  const order = LEGACY_ORDERS[orderIdOf(args)];
  return order ? ok(order) : err("No legacy order with that ID");
}

export async function getOrderV2(args: Args): Promise<ToolResult> {
  const order = V2_ORDERS[orderIdOf(args)];
  return order ? ok(order) : err("No v2 order with that ID");
}

export async function getShipment(args: Args): Promise<ToolResult> {
  const shipment = SHIPMENTS[orderIdOf(args)];
  return shipment ? ok(shipment) : err("No shipment for that order");
}

export async function processRefund(args: Args): Promise<ToolResult> {
  // No limit check here on purpose: the business rule is enforced by the PreToolUse hook.
  const refund: Refund = {
    refund_id: `RF-${String(REFUNDS.length + 1).padStart(4, "0")}`,
    order_id: String(args.order_id ?? ""),
    amount: Number(args.amount ?? 0),
    status: "processed",
  };
  REFUNDS.push(refund);
  return ok(refund);
}

export async function escalateToHuman(args: Args): Promise<ToolResult> {
  const ticket: Ticket = {
    ticket_id: `ESC-${String(ESCALATIONS.length + 1).padStart(4, "0")}`,
    order_id: String(args.order_id ?? ""),
    amount: Number(args.amount ?? 0),
    summary: String(args.summary ?? ""),
    queue: "refund-approvals",
  };
  ESCALATIONS.push(ticket);
  return ok(ticket);
}

export const DESCRIPTIONS: Record<string, string> = {
  get_order_legacy:
    "Look up an order in the LEGACY order system (orders placed before the 2026 migration, IDs ORD-1xxx). " +
    "Returns the order's status, timestamps and total.",
  get_order_v2: "Look up an order on the current order platform (IDs ORD-2xxx). Returns status, timestamps and total.",
  get_shipment: "Get the carrier, tracking number, ship date and estimated delivery date for an order.",
  process_refund: "Refund an amount in USD to the customer's original payment method for one order.",
  escalate_to_human:
    "Hand the case to a human support agent who can approve exceptions such as large refunds. " +
    "Include the order ID, the amount involved and a one-line summary; the human cannot see this conversation.",
};

/** Parameter types per tool (mirrors the Python {"order_id": str} schemas). */
export const PARAMS: Record<string, Record<string, "string" | "number">> = {
  get_order_legacy: { order_id: "string" },
  get_order_v2: { order_id: "string" },
  get_shipment: { order_id: "string" },
  process_refund: { order_id: "string", amount: "number", reason: "string" },
  escalate_to_human: { order_id: "string", amount: "number", summary: "string" },
};

export const HANDLERS: Record<string, (args: Args) => Promise<ToolResult>> = {
  get_order_legacy: getOrderLegacy,
  get_order_v2: getOrderV2,
  get_shipment: getShipment,
  process_refund: processRefund,
  escalate_to_human: escalateToHuman,
};

/** The in-process MCP server passed as options.mcpServers.shop in the live run. */
export function buildShopServer() {
  const orderOnly = { order_id: z.string() };
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool("get_order_legacy", DESCRIPTIONS.get_order_legacy, orderOnly, (args) => getOrderLegacy(args)),
      tool("get_order_v2", DESCRIPTIONS.get_order_v2, orderOnly, (args) => getOrderV2(args)),
      tool("get_shipment", DESCRIPTIONS.get_shipment, orderOnly, (args) => getShipment(args)),
      tool(
        "process_refund",
        DESCRIPTIONS.process_refund,
        { order_id: z.string(), amount: z.number(), reason: z.string() },
        (args) => processRefund(args),
      ),
      tool(
        "escalate_to_human",
        DESCRIPTIONS.escalate_to_human,
        { order_id: z.string(), amount: z.number(), summary: z.string() },
        (args) => escalateToHuman(args),
      ),
    ],
  });
}

/** The name the model (and hook matchers) see: mcp__<server>__<tool>. */
export const mcpName = (short: string) => `mcp__${SERVER_NAME}__${short}`;
export const shortName = (full: string) => full.replace(`mcp__${SERVER_NAME}__`, "");

export const ALLOWED_TOOLS = Object.keys(PARAMS).map(mcpName);

// The same tools as Messages-API definitions, used only by the offline agent loop in harness.ts.
export const API_TOOL_DEFS: Anthropic.Tool[] = Object.keys(PARAMS).map(
  (name): Anthropic.Tool => ({
    name: mcpName(name),
    description: DESCRIPTIONS[name],
    input_schema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(PARAMS[name]).map(([key, type]) => [key, { type }])),
      required: Object.keys(PARAMS[name]),
    },
  }),
);
