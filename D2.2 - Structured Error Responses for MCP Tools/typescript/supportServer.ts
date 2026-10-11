/**
 * Customer-support MCP server whose tools return STRUCTURED errors (D2.2).
 *
 * LAB_SKIP_AUTORUN - this module is imported by the demos. It only starts a real stdio MCP
 * server when run with --serve (that call blocks, waiting for an MCP client):
 *
 *   npx tsx supportServer.ts --serve            # structured errors
 *   npx tsx supportServer.ts --serve --generic  # contrast: every failure is "Operation failed"
 *
 * Every failed tool call returns `{ content: [{type: "text", text: <envelope JSON>}], isError: true }`:
 *
 *   {"errorCategory": "transient" | "validation" | "business" | "permission",
 *    "isRetryable": bool, "message": "...", "customerMessage"?: "...",
 *    "retryAfterSeconds"?: 2, "details": {...}}
 *
 * A search with no matches is NOT an error: it is a successful query whose answer is
 * "nothing found" ({"results": [], "matched": 0}). Only access failures are errors.
 *
 * Offline demos call the exported handler functions directly; they are registered on an
 * McpServer (v1 API) only in the serve path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as lab from "../../shared/typescript/labkit.ts";

const ORDER_ID = /^ORD-\d{4}$/;
const REFUND_LIMIT = 500; // refunds above this need a supervisor (a business rule, not a code error)

/** MCP CallToolResult shape (a type alias, so it is assignable to the SDK's result type). */
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
export type Style = "structured" | "generic";

// ---------------------------------------------------------------------------
// Fake backend with injectable failures. It also keeps a ground-truth log of what
// REALLY happened on each call, so the demos can count wasted retries objectively.
// ---------------------------------------------------------------------------

export class BackendTimeout extends Error {}

interface Order {
  order_id: string;
  account: string;
  status: string;
  total: number;
  items: string[];
}
interface KbDoc {
  id: string;
  title: string;
  snippet: string;
}
export interface LogEntry {
  tool: string;
  args: Record<string, unknown>;
  outcome: string;
}

export class Backend {
  orders: Record<string, Order> = {
    "ORD-1001": { order_id: "ORD-1001", account: "consumer", status: "delivered", total: 1199, items: ["4K monitor"] },
    "ORD-1002": { order_id: "ORD-1002", account: "consumer", status: "shipped", total: 89.9, items: ["Headphones"] },
    "ORD-3003": { order_id: "ORD-3003", account: "corporate", status: "delivered", total: 240, items: ["Docking station"] },
  };
  kb: KbDoc[] = [
    { id: "KB-12", title: "Return window for electronics", snippet: "30 days from delivery; 15 days for opened headphones." },
    { id: "KB-31", title: "Refund approval limits", snippet: "Agents may refund up to $500; above that a supervisor approves." },
  ];
  lookupTimeouts: Record<string, number> = {}; // order_id -> timeouts still to inject
  kbDown = false;
  callerScopes = new Set<string>(["orders:read", "refunds:write"]);
  log: LogEntry[] = [];

  record(tool: string, args: Record<string, unknown>, outcome: string): void {
    this.log.push({ tool, args: { ...args }, outcome });
  }

  getOrder(orderId: string): Order | undefined {
    if ((this.lookupTimeouts[orderId] ?? 0) > 0) {
      this.lookupTimeouts[orderId] -= 1;
      throw new BackendTimeout("order service did not answer within 2s");
    }
    return this.orders[orderId];
  }

  search(query: string, limit: number): KbDoc[] {
    if (this.kbDown) throw new BackendTimeout("knowledge-base cluster unavailable (503)");
    const words = new Set((query.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 3));
    const hits = this.kb.filter((doc) =>
      ((doc.title + " " + doc.snippet).toLowerCase().match(/[a-z]+/g) ?? []).some((w) => words.has(w)),
    );
    return hits.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// The error envelope
// ---------------------------------------------------------------------------

interface FailureOptions {
  retryable: boolean;
  customerMessage?: string;
  retryAfterS?: number;
  details?: Record<string, unknown>;
}

/** A failure the tool understands well enough to classify. */
export class ToolFailure extends Error {
  readonly category: string;
  readonly envelope: Record<string, unknown>;

  constructor(category: string, message: string, opts: FailureOptions) {
    super(message);
    this.category = category;
    this.envelope = { errorCategory: category, isRetryable: opts.retryable, message };
    if (opts.customerMessage) this.envelope.customerMessage = opts.customerMessage;
    if (opts.retryAfterS !== undefined) this.envelope.retryAfterSeconds = opts.retryAfterS;
    this.envelope.details = opts.details ?? {};
  }
}

function textResult(payload: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

// ---------------------------------------------------------------------------
// Tool logic (pure functions over the backend; throw ToolFailure on failure)
// ---------------------------------------------------------------------------

function validateOrderId(orderId: string): void {
  if (!ORDER_ID.test(orderId)) {
    throw new ToolFailure(
      "validation",
      `order_id '${orderId}' is not in the format ORD-#### (for example ORD-1001). ` +
        "Correct the value and call again; retrying the same value will fail the same way.",
      { retryable: false, details: { field: "order_id", expected_format: "ORD-####", received: orderId } },
    );
  }
}

function fetchOrder(backend: Backend, orderId: string): Order | undefined {
  try {
    return backend.getOrder(orderId);
  } catch (exc) {
    if (!(exc instanceof BackendTimeout)) throw exc;
    throw new ToolFailure("transient", `Order service timed out (${exc.message}). Safe to retry the same call after a short wait.`, {
      retryable: true,
      retryAfterS: 1,
      details: { service: "orders", timeout_s: 2 },
    });
  }
}

export function lookupOrderLogic(backend: Backend, orderId: string): Record<string, unknown> {
  validateOrderId(orderId);
  const order = fetchOrder(backend, orderId);
  // Not found by exact id is a valid answer, not an access failure.
  if (!order) return { found: false, order_id: orderId };
  return { found: true, ...order };
}

export function processRefundLogic(backend: Backend, orderId: string, amount: number): Record<string, unknown> {
  validateOrderId(orderId);
  if (!(amount > 0)) {
    throw new ToolFailure("validation", `amount must be a positive number of dollars, got ${amount}.`, {
      retryable: false,
      details: { field: "amount", received: amount },
    });
  }
  const order = fetchOrder(backend, orderId);
  if (!order) {
    throw new ToolFailure("validation", `No order ${orderId}; check the id with the customer.`, {
      retryable: false,
      details: { field: "order_id", received: orderId },
    });
  }
  if (order.account === "corporate" && !backend.callerScopes.has("refunds:corporate")) {
    throw new ToolFailure(
      "permission",
      "This credential lacks the refunds:corporate scope required for refunds on corporate " +
        "accounts. Do not retry; escalate to a human agent who holds that scope.",
      { retryable: false, details: { required_scope: "refunds:corporate", caller_scopes: [...backend.callerScopes].sort() } },
    );
  }
  if (amount > REFUND_LIMIT) {
    throw new ToolFailure(
      "business",
      `Refund of $${amount.toFixed(2)} exceeds the $${REFUND_LIMIT} agent limit (policy REFUND-4.2). ` +
        "Not retryable. Explain to the customer using customerMessage and offer a supervisor review.",
      {
        retryable: false,
        customerMessage:
          `Refunds over $${REFUND_LIMIT} need a supervisor's approval, so I can't issue this ` +
          "one directly. I can request a supervisor review for you.",
        details: { policy: "REFUND-4.2", limit: REFUND_LIMIT, requested: amount },
      },
    );
  }
  if (amount > order.total) {
    throw new ToolFailure("business", `Refund $${amount.toFixed(2)} is more than the order total $${order.total.toFixed(2)}.`, {
      retryable: false,
      customerMessage: `I can refund at most the order total of $${order.total.toFixed(2)}.`,
      details: { order_total: order.total, requested: amount },
    });
  }
  return { refund_id: `RF-${orderId.slice(-4)}`, status: "issued", amount };
}

export function searchKbLogic(backend: Backend, query: string, limit: number): Record<string, unknown> {
  if (!query.trim()) throw new ToolFailure("validation", "query must not be empty.", { retryable: false, details: { field: "query" } });
  let hits: KbDoc[] = [];
  try {
    hits = backend.search(query, limit);
  } catch (exc) {
    if (!(exc instanceof BackendTimeout)) throw exc;
    throw new ToolFailure(
      "transient",
      `Knowledge base unavailable (${exc.message}). This is an access failure, not 'no results'. ` +
        "Safe to retry after the suggested wait.",
      { retryable: true, retryAfterS: 2, details: { service: "kb" } },
    );
  }
  // Zero hits is a SUCCESSFUL query. Returning isError here would make the agent retry
  // a question that was already answered ("nothing matches").
  return { results: hits, matched: hits.length, query };
}

// ---------------------------------------------------------------------------
// Handlers (called directly offline) and the MCP server (serve path)
// ---------------------------------------------------------------------------

export const DESCRIPTIONS: Record<string, string> = {
  lookup_order:
    "Fetch one order by id and return {found, order_id, status, total, items, account}. " +
    "Input: order_id in the format ORD-#### (for example ORD-1001). An unknown id is a " +
    "successful lookup with found=false. Errors come back with isError and a JSON body " +
    "{errorCategory, isRetryable, message, details}: transient (timeouts, safe to retry), " +
    "validation (bad id format, fix the input).",
  process_refund:
    "Issue a refund for an order and return {refund_id, status, amount}. Input: order_id " +
    "(ORD-####) and amount in dollars. Agents may refund up to $500 on consumer accounts. " +
    "Errors come back with isError and {errorCategory, isRetryable, message, customerMessage?, " +
    "details}: business (policy limits - never retry; tell the customer using customerMessage), " +
    "permission (escalate), validation (fix the input).",
  search_kb:
    "Search the support knowledge base and return {results: [{id, title, snippet}], matched, " +
    "query}. matched=0 means the query worked and nothing matched - do not retry it; " +
    "rephrase or answer without the KB. Errors (isError) are access failures only: " +
    "transient with retryAfterSeconds when the KB is down.",
};

/** Messages API tool definitions mirroring the zod shapes registered in buildServer(). */
export const TOOL_DEFS = [
  {
    name: "lookup_order",
    description: DESCRIPTIONS.lookup_order,
    input_schema: {
      type: "object" as const,
      properties: { order_id: { type: "string", description: "Order id, format ORD-#### (ORD-1001)" } },
      required: ["order_id"],
    },
  },
  {
    name: "process_refund",
    description: DESCRIPTIONS.process_refund,
    input_schema: {
      type: "object" as const,
      properties: {
        order_id: { type: "string", description: "Order id, format ORD-####" },
        amount: { type: "number", description: "Refund amount in dollars, > 0" },
      },
      required: ["order_id", "amount"],
    },
  },
  {
    name: "search_kb",
    description: DESCRIPTIONS.search_kb,
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        limit: { type: "integer", description: "Maximum results to return (1-10)" },
      },
      required: ["query"],
    },
  },
];

/** The same three tools; `style` controls only how failures are reported. */
export function makeHandlers(backend: Backend, style: Style = "structured"): Record<string, Handler> {
  const respond = async (tool: string, args: Record<string, unknown>, op: () => Record<string, unknown>): Promise<ToolResult> => {
    let payload: Record<string, unknown>;
    try {
      payload = op();
    } catch (exc) {
      if (!(exc instanceof ToolFailure)) throw exc;
      backend.record(tool, args, exc.category);
      // The anti-pattern: one uniform message for every failure.
      if (style === "generic") return textResult({ error: "Operation failed" }, true);
      return textResult(exc.envelope, true);
    }
    const empty = payload.matched === 0;
    backend.record(tool, args, empty ? "empty" : "ok");
    // A common companion bug: "no results" raised as an exception -> reported as failure.
    if (style === "generic" && empty) return textResult({ error: "Operation failed" }, true);
    return textResult(payload);
  };

  return {
    lookup_order: (args) => {
      const orderId = String(args.order_id ?? "");
      return respond("lookup_order", { order_id: orderId }, () => lookupOrderLogic(backend, orderId));
    },
    process_refund: (args) => {
      const orderId = String(args.order_id ?? "");
      const amount = Number(args.amount ?? 0);
      return respond("process_refund", { order_id: orderId, amount }, () => processRefundLogic(backend, orderId, amount));
    },
    search_kb: (args) => {
      const query = String(args.query ?? "");
      const limit = Number(args.limit ?? 5);
      return respond("search_kb", { query }, () => searchKbLogic(backend, query, limit));
    },
  };
}

export function buildServer(backend: Backend, style: Style = "structured"): McpServer {
  const handlers = makeHandlers(backend, style);
  const server = new McpServer({ name: style === "structured" ? "support-tools" : "support-tools-generic", version: "1.0.0" });
  server.registerTool(
    "lookup_order",
    { description: DESCRIPTIONS.lookup_order, inputSchema: { order_id: z.string().describe("Order id, format ORD-#### (ORD-1001)") } },
    async ({ order_id }) => handlers.lookup_order({ order_id }),
  );
  server.registerTool(
    "process_refund",
    {
      description: DESCRIPTIONS.process_refund,
      inputSchema: {
        order_id: z.string().describe("Order id, format ORD-####"),
        amount: z.number().describe("Refund amount in dollars, > 0"),
      },
    },
    async ({ order_id, amount }) => handlers.process_refund({ order_id, amount }),
  );
  server.registerTool(
    "search_kb",
    {
      description: DESCRIPTIONS.search_kb,
      inputSchema: {
        query: z.string().describe("Natural-language search query"),
        limit: z.number().int().optional().describe("Maximum results to return (1-10)"),
      },
    },
    async ({ query, limit }) => handlers.search_kb({ query, limit }),
  );
  return server;
}

if (lab.isMain(import.meta.url)) {
  if (process.argv.includes("--serve")) {
    // stdio transport: stdout belongs to the MCP protocol, so never console.log here.
    const style: Style = process.argv.includes("--generic") ? "generic" : "structured";
    await buildServer(new Backend(), style).connect(new StdioServerTransport());
  } else {
    console.log("Run with --serve to start the stdio MCP server (add --generic for the contrast variant).");
    console.log("For the offline demo run: npx tsx recoveryDemo.ts");
  }
}
