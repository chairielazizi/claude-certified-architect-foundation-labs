/**
 * Tool catalog and per-agent tool distribution for the multi-agent research system (D2.3).
 *
 * The catalog has 18 tools. Two ways to hand them out:
 *  - SCOPED_CONFIG      each subagent gets only the tools its role needs, plus one deliberate
 *                       cross-role tool: verify_fact for the synthesis agent (sample Q9).
 *  - EVERYTHING_CONFIG  "give everyone everything": all 18 tools on every agent.
 *
 * checkDistribution() is the review you would run in CI on an agent config: it warns when an
 * agent has too many tools or tools outside its specialization.
 */

// name -> [category, one-line purpose]. Descriptions are short here because this module is
// about WHO gets a tool; D2.1 covers how to write the description itself.
export const CATALOG: Record<string, [string, string]> = {
  web_search: ["search", "Search the web and return ranked results"],
  fetch_url: ["retrieval", "Fetch any URL (generic; replaced by load_document)"],
  load_document: ["retrieval", "Load an allowlisted https document URL (pdf/html/txt)"],
  extract_data_points: ["analysis", "Extract named facts from one document"],
  summarize_content: ["analysis", "Summarise one document"],
  extract_metadata: ["analysis", "Title, authors, year, DOI of a document"],
  classify_document: ["analysis", "Classify a document by type and topic"],
  translate_text: ["analysis", "Translate text between languages"],
  verify_fact: ["verification", "Check ONE simple fact (date, name, number) against a reference index"],
  deep_verify_claim: ["verification", "Multi-source investigation of a complex claim"],
  merge_findings: ["synthesis", "Merge findings from several subagents"],
  detect_coverage_gaps: ["synthesis", "Find topics the findings do not cover"],
  format_report: ["report", "Render the final cited report"],
  generate_chart: ["report", "Render a chart for the report"],
  export_pdf: ["report", "Export the report as PDF"],
  send_email: ["comms", "Email a report to recipients"],
  run_python: ["compute", "Execute arbitrary Python code"],
  query_database: ["data", "Run SQL against the analytics warehouse"],
};

/** Each role's specialization = the tool categories it is supposed to use. */
export const ROLES: Record<string, Set<string>> = {
  web_search_agent: new Set(["search", "retrieval"]),
  document_analysis_agent: new Set(["analysis"]),
  synthesis_agent: new Set(["synthesis"]),
  report_agent: new Set(["report"]),
};

// Deliberate, documented exceptions to the specialization rule. Keep this list short:
// every entry should name the high-frequency need that justifies it.
export const CROSS_ROLE_ALLOWANCES: Record<string, string> = {
  "synthesis_agent/verify_fact":
    "85% of verification needs are simple fact checks (dates, names, statistics); a scoped " +
    "tool removes 2-3 coordinator round trips each. Complex claims still go via the coordinator.",
};

export const SCOPED_CONFIG: Record<string, string[]> = {
  web_search_agent: ["web_search", "load_document"],
  document_analysis_agent: ["extract_data_points", "summarize_content"],
  synthesis_agent: ["verify_fact"], // synthesis works from findings passed in its prompt
  report_agent: ["format_report"],
};

export const EVERYTHING_CONFIG: Record<string, string[]> = Object.fromEntries(
  Object.keys(ROLES).map((role) => [role, Object.keys(CATALOG)]),
);

export const MAX_TOOLS_PER_AGENT = 6; // beyond ~4-6 tools, selection reliability drops (exam: 18 vs 4-5)

export type Finding = [level: "error" | "warn" | "info", message: string];

/** A Messages API tool definition for a catalog entry (used when building an agent). */
export function toolDefinition(name: string): Record<string, unknown> {
  const [category, purpose] = CATALOG[name];
  return {
    name,
    description: `${purpose}. Category: ${category}.`,
    input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  };
}

/** Per agent: list of [level, message]. */
export function checkDistribution(config: Record<string, string[]>): Record<string, Finding[]> {
  const report: Record<string, Finding[]> = {};
  for (const [role, tools] of Object.entries(config)) {
    const findings: Finding[] = [];
    const specialization = ROLES[role] ?? new Set<string>();
    if (tools.length > MAX_TOOLS_PER_AGENT) {
      findings.push(["warn", `${tools.length} tools (> ${MAX_TOOLS_PER_AGENT}): more choices per step, less reliable selection`]);
    }
    const outside: string[] = [];
    for (const tool of tools) {
      const entry = CATALOG[tool];
      if (!entry) {
        findings.push(["error", `unknown tool ${tool}`]);
        continue;
      }
      const category = entry[0];
      if (specialization.has(category)) continue;
      const reason = CROSS_ROLE_ALLOWANCES[`${role}/${tool}`];
      if (reason) findings.push(["info", `scoped cross-role tool ${tool}: ${reason}`]);
      else outside.push(`${tool}(${category})`);
    }
    if (outside.length > 0) {
      const shown = outside.slice(0, 4).join(", ") + (outside.length > 4 ? `, +${outside.length - 4} more` : "");
      findings.push(["warn", `${outside.length} tool(s) outside its specialization ${JSON.stringify([...specialization].sort())}: ${shown}`]);
    }
    report[role] = findings;
  }
  return report;
}

export function count(report: Record<string, Finding[]>, level: string): number {
  return Object.values(report).reduce((n, findings) => n + findings.filter(([lvl]) => lvl === level).length, 0);
}
