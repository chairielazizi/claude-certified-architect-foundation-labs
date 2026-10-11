/**
 * Team knowledge-base MCP server (TypeScript twin of example-project/servers/team_kb_server.py).
 *
 * LAB_SKIP_AUTORUN - imported by the lab demos; runs as a real stdio MCP server only with
 * --serve (that call blocks waiting for an MCP client such as Claude Code):
 *
 *   npx tsx teamKbServer.ts --serve
 *
 * Why a CUSTOM server: GitHub and Jira already have community/vendor MCP servers, so the team
 * does not rebuild them. Runbooks, ADRs, service ownership and warehouse schema are
 * team-specific, so they get a small custom server.
 *  - Tool descriptions spell out capabilities and outputs in detail, including why to prefer
 *    them over the built-in Grep (the data is not in the repository at all).
 *  - Resources expose content CATALOGS (issue summaries, docs hierarchy, database schema) so an
 *    agent sees what exists without spending exploratory tool calls.
 *
 * Offline demos call the exported handlers / resource readers directly; they are registered on
 * an McpServer (v1 API) only in the serve path. Data is an in-memory fixture; a real server
 * would call KB_URL with KB_TOKEN (injected via ${VAR} expansion in .mcp.json).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as lab from "../../shared/typescript/labkit.ts";

const KB_URL = process.env.KB_URL ?? "http://localhost:8080";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

interface KbDoc {
  title: string;
  kind: string;
  path: string;
  updated: string;
  body: string;
}
interface Column {
  name: string;
  type: string;
  description: string;
  pii: boolean;
}

const DOCS: Record<string, KbDoc> = {
  "RB-014": { title: "Payments service runbook", kind: "runbook", path: "runbooks/payments.md", updated: "2026-09-30",
    body: "Restart order: ledger-worker, then payments-api. Refund backlog alarms page #payments-oncall." },
  "ADR-007": { title: "ADR-007: Postgres for the refund ledger", kind: "adr", path: "adr/007-refund-ledger.md", updated: "2025-11-02",
    body: "We chose Postgres over DynamoDB for refunds because finance needs ad-hoc SQL and strict consistency." },
  "PM-2026-03": { title: "Postmortem: duplicate refunds on 2026-03-14", kind: "postmortem", path: "postmortems/2026-03-14.md", updated: "2026-03-20",
    body: "A retry without an idempotency key issued 212 duplicate refunds. Fix: idempotency keys on process_refund." },
  "GD-001": { title: "Onboarding: how we deploy", kind: "guide", path: "guides/deploy.md", updated: "2026-08-12",
    body: "Deploys go through the release train on Tuesdays and Thursdays; hotfixes need an on-call approver." },
};
const SERVICES: Record<string, { team: string; oncall: string; slack: string; runbook: string }> = {
  payments: { team: "Payments Platform", oncall: "payments-primary", slack: "#payments-oncall", runbook: "RB-014" },
  search: { team: "Discovery", oncall: "discovery-primary", slack: "#discovery", runbook: "RB-022" },
};
const TABLES: Record<string, { rows: number; columns: Column[] }> = {
  orders: { rows: 1_204_331, columns: [
    { name: "order_id", type: "text", description: "ORD-#### id", pii: false },
    { name: "customer_id", type: "text", description: "FK customers", pii: false },
    { name: "total", type: "numeric(10,2)", description: "Order total in USD", pii: false },
  ] },
  customers: { rows: 310_552, columns: [
    { name: "customer_id", type: "text", description: "C-#### id", pii: false },
    { name: "email", type: "text", description: "Login email", pii: true },
  ] },
  refund_events: { rows: 48_920, columns: [
    { name: "refund_id", type: "text", description: "RF-#### id", pii: false },
    { name: "order_id", type: "text", description: "FK orders", pii: false },
    { name: "refund_reason", type: "text", description: "Agent-selected reason code (DAMAGED, LATE, ...)", pii: false },
    { name: "idempotency_key", type: "uuid", description: "Added after PM-2026-03", pii: false },
  ] },
};
const ISSUES = [
  { key: "PAY-311", title: "Refund reason codes not validated against enum", status: "open", service: "payments", severity: "medium" },
  { key: "PAY-298", title: "Ledger worker memory leak under backlog", status: "in_progress", service: "payments", severity: "high" },
  { key: "DSC-120", title: "Synonyms missing for 'headphones'", status: "open", service: "search", severity: "low" },
];

export const DESCRIPTIONS: Record<string, string> = {
  search_kb:
    "Search the team knowledge base: runbooks, architecture decision records (ADRs), postmortems " +
    "and onboarding guides (about 1,200 pages held by the KB service, NOT in this repository, so " +
    "the built-in Grep and Glob tools cannot see them). Matches by meaning as well as words: " +
    "'why did we pick Postgres for refunds' finds ADR-007. Returns {matched, results: [{doc_id, " +
    "title, kind, path, updated, snippet}]}; matched=0 is a valid answer, not an error. Input: " +
    "query in plain language, optional kind (runbook|adr|postmortem|guide), limit 1-20 (default 5). " +
    "Prefer this over Grep for how/why questions, incident history and team conventions; use Grep " +
    "only to search code in this repository. Follow up with get_doc for the full text.",
  get_doc:
    "Return the full markdown of one knowledge-base document with its metadata: {doc_id, title, " +
    "kind, path, updated, body}. Input: doc_id as returned by search_kb or listed in the " +
    "catalog://docs/hierarchy resource (for example RB-014, ADR-007). Unknown ids return an error " +
    "with isError true. Use this instead of reading files: KB documents are not on disk here.",
  find_service_owner:
    "Look up who owns a service in the service catalog: returns {service, team, oncall, slack, " +
    "runbook} where runbook is a doc_id for get_doc. Input: service name such as payments or " +
    "search. Use it for 'who do I page', 'which team owns', 'where is the runbook' questions; " +
    "CODEOWNERS files in the repo are often stale, this catalog is the source of truth.",
  describe_table:
    "Describe one analytics-warehouse table: returns {table, rows, columns: [{name, type, " +
    "description, pii}]}. Input: table name exactly as listed in the catalog://db/schema " +
    "resource (read that first instead of guessing names). Columns flagged pii=true must not be " +
    "selected into reports. Unknown tables return an error with isError true.",
};

const json = (payload: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }], isError });

export function searchDocs(query: string, kind?: string, limit = 5): Record<string, unknown> {
  const words = query.split(/\s+/).filter((w) => w.length > 3).map((w) => w.replace(/^[?'.,]+|[?'.,]+$/g, "").toLowerCase());
  const hits: Record<string, unknown>[] = [];
  for (const [docId, doc] of Object.entries(DOCS)) {
    if (kind && doc.kind !== kind) continue;
    const text = `${doc.title} ${doc.body}`.toLowerCase();
    if (words.some((w) => text.includes(w))) {
      hits.push({ doc_id: docId, title: doc.title, kind: doc.kind, path: doc.path, updated: doc.updated, snippet: doc.body.slice(0, 80) });
    }
  }
  return { matched: hits.slice(0, limit).length, results: hits.slice(0, limit), source: KB_URL };
}

/** Tool handlers (called directly by the offline demos, registered on McpServer in serve mode). */
export const handlers = {
  search_kb: async (args: { query: string; kind?: string; limit?: number }): Promise<ToolResult> =>
    json(searchDocs(args.query, args.kind, args.limit ?? 5)),
  get_doc: async (args: { doc_id: string }): Promise<ToolResult> => {
    const doc = DOCS[args.doc_id];
    if (!doc) return json({ errorCategory: "validation", isRetryable: false, message: `unknown doc_id ${args.doc_id}; see catalog://docs/hierarchy` }, true);
    return json({ doc_id: args.doc_id, ...doc });
  },
  find_service_owner: async (args: { service: string }): Promise<ToolResult> => {
    const owner = SERVICES[args.service.toLowerCase()];
    if (!owner) {
      return json({ errorCategory: "validation", isRetryable: false, message: `unknown service ${args.service}`, details: { known: Object.keys(SERVICES).sort() } }, true);
    }
    return json({ service: args.service.toLowerCase(), ...owner });
  },
  describe_table: async (args: { table: string }): Promise<ToolResult> => {
    const info = TABLES[args.table];
    if (!info) return json({ errorCategory: "validation", isRetryable: false, message: `unknown table ${args.table}; read catalog://db/schema` }, true);
    return json({ table: args.table, ...info });
  },
};

// --- Resources: catalogs the agent (or the app) can read without exploratory tool calls ---

export interface ResourceInfo {
  name: string;
  uri: string;
  description: string;
  mimeType: string;
  read: () => string;
}

export const RESOURCES: ResourceInfo[] = [
  {
    name: "issues-summary",
    uri: "catalog://issues/summary",
    description: "Open issues for team services: key, title, status, service, severity.",
    mimeType: "application/json",
    read: () => JSON.stringify(ISSUES),
  },
  {
    name: "docs-hierarchy",
    uri: "catalog://docs/hierarchy",
    description: "Knowledge-base tree by kind with doc_id, title and last update.",
    mimeType: "application/json",
    read: () => {
      const tree: Record<string, { doc_id: string; title: string; updated: string }[]> = {};
      for (const [docId, doc] of Object.entries(DOCS)) (tree[doc.kind] ??= []).push({ doc_id: docId, title: doc.title, updated: doc.updated });
      return JSON.stringify(tree);
    },
  },
  {
    name: "db-schema",
    uri: "catalog://db/schema",
    description: "Warehouse tables with column names and types (no data). Read before describe_table.",
    mimeType: "application/json",
    read: () => JSON.stringify(Object.fromEntries(Object.entries(TABLES).map(([name, info]) => [name, info.columns.map((c) => `${c.name}:${c.type}`)]))),
  },
];

export function readResource(uri: string): string {
  const res = RESOURCES.find((r) => r.uri === uri);
  if (!res) throw new Error(`unknown resource ${uri}`);
  return res.read();
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "team-kb", version: "1.0.0" });
  server.registerTool(
    "search_kb",
    {
      description: DESCRIPTIONS.search_kb,
      inputSchema: {
        query: z.string().describe("Plain-language question or keywords"),
        kind: z.string().optional().describe("Optional filter: runbook, adr, postmortem or guide"),
        limit: z.number().int().optional().describe("Maximum results, 1-20"),
      },
    },
    async ({ query, kind, limit }) => handlers.search_kb({ query, kind, limit }),
  );
  server.registerTool(
    "get_doc",
    { description: DESCRIPTIONS.get_doc, inputSchema: { doc_id: z.string().describe("Document id such as RB-014 or ADR-007") } },
    async ({ doc_id }) => handlers.get_doc({ doc_id }),
  );
  server.registerTool(
    "find_service_owner",
    { description: DESCRIPTIONS.find_service_owner, inputSchema: { service: z.string().describe("Service name, for example payments") } },
    async ({ service }) => handlers.find_service_owner({ service }),
  );
  server.registerTool(
    "describe_table",
    { description: DESCRIPTIONS.describe_table, inputSchema: { table: z.string().describe("Table name from catalog://db/schema") } },
    async ({ table }) => handlers.describe_table({ table }),
  );
  for (const res of RESOURCES) {
    server.registerResource(res.name, res.uri, { description: res.description, mimeType: res.mimeType }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.read() }],
    }));
  }
  return server;
}

if (lab.isMain(import.meta.url)) {
  if (process.argv.includes("--serve")) {
    await buildServer().connect(new StdioServerTransport()); // stdio: never console.log here
  } else {
    console.log("Run with --serve to start the stdio MCP server.");
  }
}
