/**
 * D2.4 - Inspect a project .mcp.json: secrets lint, ${VAR} expansion, tool union.
 *
 *   1. lint:     credentials must come from ${VAR} references, never literals. Runs on the
 *                committed example-project/.mcp.json (clean) and on a leaky variant (flagged).
 *   2. expand:   the ${VAR} / ${VAR:-default} expansion Claude Code applies to command, args,
 *                env, url and headers, run against a FAKE environment. Unset without a default
 *                -> warning, and the text stays literal.
 *   3. discover: tools from ALL configured servers are available at the same time, named
 *                mcp__<server>__<tool>. team-kb's list comes from teamKbServer.ts; the github /
 *                issue-tracker lists are ILLUSTRATIVE (the real ones arrive at connection time).
 *
 * Always offline. Run:  npx tsx inspectMcpConfig.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";
import { DESCRIPTIONS } from "./teamKbServer.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, "..", "example-project");

interface ServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}
interface McpConfig {
  mcpServers: Record<string, ServerConfig>;
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const hasVar = (s: string) => /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/.test(s);
const SENSITIVE_KEY = /token|secret|passw|api[_-]?key|authorization|auth/i;
const TOKEN_SHAPE = /(ghp_|github_pat_|xox[abpr]-|sk-|AKIA)[A-Za-z0-9_-]{8,}/;

const SERVER_KIND: Record<string, string> = {
  github: "existing vendor server (remote http) - standard integration, not built here",
  "issue-tracker": "EXAMPLE community/vendor issue-tracker server - standard integration, not built here",
  "team-kb": "custom server (servers/team_kb_server.py) - team-specific KB, owners, schema",
};
const ILLUSTRATIVE_REMOTE_TOOLS: Record<string, string[]> = {
  // names for illustration only; real lists come from the servers
  github: ["search_code", "get_pull_request", "create_issue", "list_commits"],
  "issue-tracker": ["search_issues", "get_issue", "add_comment"],
};

// A config someone might be tempted to commit. The token is assembled at runtime so that no
// token-shaped literal sits in this repository.
const FAKE_PAT = "ghp_" + "0".repeat(36);
const LEAKY_CONFIG: McpConfig = {
  mcpServers: {
    github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: `Bearer ${FAKE_PAT}` } },
    "team-kb": {
      type: "stdio",
      command: "python",
      args: ["servers/team_kb_server.py", "--serve"],
      env: { KB_TOKEN: "kb-prod-7f3a9c1e", KB_URL: "http://localhost:8080" },
    },
  },
};

const FAKE_ENV: Record<string, string> = { GITHUB_TOKEN: "gh-test-token-123", KB_TOKEN: "kb-test-token-456" }; // JIRA_*, KB_URL unset

function lintSecrets(config: McpConfig): string[] {
  const findings: string[] = [];
  for (const [name, server] of Object.entries(config.mcpServers)) {
    for (const section of ["headers", "env"] as const) {
      for (const [key, value] of Object.entries(server[section] ?? {})) {
        if (SENSITIVE_KEY.test(key) && !hasVar(value)) {
          const v = section === "env" ? key : `${name.toUpperCase().replace(/-/g, "_")}_TOKEN`;
          findings.push(`${name}.${section}.${key}: literal credential; reference \${${v}} instead`);
        }
      }
    }
    const strings = [server.url ?? "", server.command ?? "", ...(server.args ?? []), ...Object.values(server.headers ?? {}), ...Object.values(server.env ?? {})];
    for (const value of strings) {
      if (TOKEN_SHAPE.test(value)) findings.push(`${name}: token-shaped literal ${value.slice(0, 12)}... will be committed with the file`);
    }
  }
  return findings;
}

function expand(value: string, env: Record<string, string>, warnings: string[]): string {
  return value.replace(VAR, (whole: string, name: string, def: string | undefined) => {
    if (name in env) return env[name];
    if (def !== undefined) return def;
    warnings.push(`\${${name}} is not set and has no default; the literal text is kept`);
    return whole;
  });
}

/** Apply expansion where Claude Code does: command, args, env, url, headers. */
function expandServer(server: ServerConfig, env: Record<string, string>): [ServerConfig, string[]] {
  const warnings: string[] = [];
  const out: ServerConfig = JSON.parse(JSON.stringify(server)) as ServerConfig;
  if (out.command !== undefined) out.command = expand(out.command, env, warnings);
  if (out.url !== undefined) out.url = expand(out.url, env, warnings);
  if (out.args) out.args = out.args.map((a) => expand(a, env, warnings));
  for (const section of ["env", "headers"] as const) {
    const values = out[section];
    if (values) out[section] = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expand(v, env, warnings)]));
  }
  return [out, warnings];
}

/** Hide credential values when printing. */
function masked(server: ServerConfig): ServerConfig {
  const out: ServerConfig = JSON.parse(JSON.stringify(server)) as ServerConfig;
  for (const section of ["env", "headers"] as const) {
    const values = out[section];
    if (!values) continue;
    for (const [k, v] of Object.entries(values)) if (SENSITIVE_KEY.test(k) && !hasVar(v)) values[k] = v.slice(0, 10) + "****";
  }
  return out;
}

lab.banner("D2.4  Inspect .mcp.json: secrets, ${VAR} expansion, tools from every server");
const config = JSON.parse(readFileSync(path.join(PROJECT, ".mcp.json"), "utf-8")) as McpConfig;

lab.section("1. Secrets lint");
const committed = lintSecrets(config);
const leaky = lintSecrets(LEAKY_CONFIG);
console.log(`  example-project/.mcp.json: ${committed.length} finding(s)`);
console.log("  leaky variant:");
for (const f of leaky) console.log(`      - ${f}`);

lab.section("2. Expansion against a fake environment");
console.log(`  fake env: ${JSON.stringify(Object.fromEntries(Object.entries(FAKE_ENV).map(([k, v]) => [k, v.slice(0, 7) + "..."])))}  (JIRA_MCP_URL, JIRA_API_TOKEN, KB_URL unset)`);
const expanded: Record<string, ServerConfig> = {};
const allWarnings: string[] = [];
for (const [name, server] of Object.entries(config.mcpServers)) {
  const [result, warnings] = expandServer(server, FAKE_ENV);
  expanded[name] = result;
  allWarnings.push(...warnings);
  console.log(`  ${name}: ${JSON.stringify(masked(result))}`);
  for (const w of warnings) console.log(`      WARNING ${w}`);
}

lab.section("3. Servers and the tools the agent sees (all at once)");
const kbTools = Object.keys(DESCRIPTIONS);
const union: string[] = [];
for (const [name, server] of Object.entries(config.mcpServers)) {
  const tools = name === "team-kb" ? kbTools : ILLUSTRATIVE_REMOTE_TOOLS[name] ?? [];
  const source = name === "team-kb" ? "from teamKbServer.ts" : "illustrative";
  console.log(`  ${name.padEnd(14)} ${(server.type ?? "stdio").padEnd(6)} ${SERVER_KIND[name] ?? ""}`);
  console.log(`      tools (${source}): ${tools.join(", ")}`);
  union.push(...tools.map((t) => `mcp__${name}__${t}`));
}
console.log(`  union seen by the agent (${union.length} tools): ${JSON.stringify(union)}`);

lab.section("Checks");
lab.check(committed.length === 0, "committed .mcp.json has no literal secrets (all credentials are ${VAR} references)");
lab.check(leaky.length >= 3, "leaky variant flagged: literal Authorization header, token-shaped value, literal KB_TOKEN");
lab.check(expanded.github.headers?.Authorization === "Bearer gh-test-token-123", "${GITHUB_TOKEN} expanded from the environment");
lab.check(expanded["team-kb"].env?.KB_URL === "http://localhost:8080", "${KB_URL:-http://localhost:8080} fell back to its default");
lab.check(
  expanded["issue-tracker"].url === "${JIRA_MCP_URL}" && allWarnings.some((w) => w.includes("JIRA_MCP_URL")),
  "unset ${JIRA_MCP_URL} without default -> warning, value left literal",
);
lab.check(
  union.length === 11 && new Set(union).size === 11 && union.every((t) => t.startsWith("mcp__")),
  "tools from all three servers are available together, namespaced mcp__<server>__<tool>",
);
