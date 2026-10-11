/**
 * D2.4 - The custom team MCP server: detailed tool descriptions and catalog resources.
 *
 * Calls the handlers and resource readers that teamKbServer.ts registers on its McpServer:
 *   1. what an agent discovers: tools (with descriptions) and resources (catalogs)
 *   2. why the descriptions win over Grep: they say what the data is, where it lives, what
 *      comes back, and when to prefer the tool
 *   3. catalog resources vs exploratory calls: answering "which table holds refund reasons,
 *      and is there an open issue about them?" with and without reading the catalogs
 *
 * Always offline (no model involved). Run:  npx tsx kbServerDemo.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { DESCRIPTIONS, RESOURCES, handlers, readResource, type ToolResult } from "./teamKbServer.ts";

// Table names an agent would plausibly guess without a catalog (it cannot list the warehouse).
const GUESSED_TABLES = ["refunds", "orders", "payments", "refund_log", "refund_events"];

const payload = (r: ToolResult) => JSON.parse(r.content[0].text) as Record<string, unknown>;

/** Exploratory tool calls: guess table names, then search for issues. */
async function withoutCatalog(): Promise<{ table: string | null; issues: string[]; calls: number }> {
  let calls = 0;
  let table: string | null = null;
  for (const guess of GUESSED_TABLES) {
    calls++;
    const result = await handlers.describe_table({ table: guess });
    const columns = (result.isError ? [] : payload(result).columns) as { name: string }[];
    if (columns.some((c) => c.name === "refund_reason")) {
      table = guess;
      break;
    }
  }
  calls++;
  const hits = payload(await handlers.search_kb({ query: "refund reason issue" })).results as { doc_id: string }[];
  // The KB holds docs, not tickets: the open issue is not found this way at all.
  const issues = hits.map((h) => h.doc_id).filter((id) => id.startsWith("PAY-"));
  return { table, issues, calls };
}

/** Read the catalogs first, then make one targeted call. */
async function withCatalog(): Promise<{ table: string | null; issues: string[]; calls: number; reads: number }> {
  const schema = JSON.parse(readResource("catalog://db/schema")) as Record<string, string[]>;
  const issues = JSON.parse(readResource("catalog://issues/summary")) as { key: string; title: string }[];
  const entry = Object.entries(schema).find(([, cols]) => cols.some((c) => c.startsWith("refund_reason:")));
  const table = entry ? entry[0] : null;
  const keys = issues.filter((i) => i.title.toLowerCase().includes("refund reason")).map((i) => i.key);
  const detail = await handlers.describe_table({ table: table ?? "" }); // one targeted call for column docs
  if (detail.isError) throw new Error("describe_table failed");
  return { table, issues: keys, calls: 1, reads: 2 };
}

lab.banner("D2.4  Custom team MCP server: tool descriptions and catalog resources");

lab.section("1. What the agent discovers at connection time");
for (const [name, desc] of Object.entries(DESCRIPTIONS)) {
  console.log(`  tool     mcp__team-kb__${name.padEnd(20)} (${desc.length} chars of description)`);
}
for (const r of RESOURCES) console.log(`  resource ${r.uri.padEnd(34)} ${r.mimeType}  ${r.description}`);

lab.section("2. A description written to beat Grep");
console.log("  " + DESCRIPTIONS.search_kb.split(". ").join(".\n  "));

lab.section("3. Catalog resources vs exploratory tool calls");
const a = await withoutCatalog();
console.log(`  without catalog: table=${a.table} issues=${JSON.stringify(a.issues)} tool_calls=${a.calls}`);
const b = await withCatalog();
console.log(`  with catalog:    table=${b.table} issues=${JSON.stringify(b.issues)} tool_calls=${b.calls} resource_reads=${b.reads}`);

lab.section("Checks");
const names = Object.keys(DESCRIPTIONS).sort();
lab.check(JSON.stringify(names) === JSON.stringify(["describe_table", "find_service_owner", "get_doc", "search_kb"]), "four team-specific tools discovered");
lab.check(
  Object.values(DESCRIPTIONS).every((d) => d.length > 300 && d.toLowerCase().includes("return")),
  "every tool description explains capabilities and outputs in detail (> 300 chars, states what it returns)",
);
lab.check(DESCRIPTIONS.search_kb.includes("Grep") && DESCRIPTIONS.search_kb.includes("NOT in this repository"), "search_kb says why to prefer it over the built-in Grep");
lab.check(
  JSON.stringify(RESOURCES.map((r) => r.uri).sort()) === JSON.stringify(["catalog://db/schema", "catalog://docs/hierarchy", "catalog://issues/summary"]),
  "issue summaries, docs hierarchy and database schema exposed as resources",
);
lab.check(a.table === "refund_events" && b.table === "refund_events", "both strategies find the refund_events table");
lab.check(b.calls < a.calls, `catalogs cut exploratory tool calls (${a.calls} -> ${b.calls})`);
lab.check(JSON.stringify(b.issues) === '["PAY-311"]' && a.issues.length === 0, "the issue summary resource surfaces PAY-311, which tool exploration missed");
