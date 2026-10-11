/**
 * D3.4 - Why verbose discovery belongs in the Explore subagent.
 *
 * Discovery done in the main conversation leaves every search result and file body in context for the
 * rest of the task. Delegated to the Explore subagent (or a custom read-only AgentDefinition), the raw
 * output fills the SUBAGENT's context and only a summary comes back. Always offline: it measures what
 * each approach would put into the main context on a generated 48-caller codebase (chars / 4).
 *
 * Run:  npx tsx exploreSubagent.ts
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_REPO = path.join(LAB, ".lab-runtime", "explore-demo-ts");
const CALLERS = 48;
const UNRELATED = 12;
const HELPERS = ["parse_date", "format_date", "days_between"];
const CONTEXT_WINDOW = 200_000; // tokens; the exact size doesn't matter, the ratio does

const tokens = (text: string) => Math.max(1, Math.floor(text.length / 4));
const toPosix = (p: string) => p.split(path.sep).join("/");

/** A deterministic codebase: 48 modules that use the legacy helpers, 12 that don't. */
function generateRepo(): void {
  rmSync(DEMO_REPO, { recursive: true, force: true });
  for (let i = 0; i < CALLERS + UNRELATED; i++) {
    const area = ["billing", "shipping", "reports", "accounts", "catalog"][i % 5];
    const file = path.join(DEMO_REPO, area, `module_${String(i).padStart(2, "0")}.py`);
    mkdirSync(path.dirname(file), { recursive: true });
    const used = i < CALLERS ? [HELPERS[i % 3], HELPERS[(i + 1) % 3]] : [];
    const header = used.length ? `from common.legacy_dates import ${[...used].sort().join(", ")}\n\n` : "";
    let body = "";
    for (let n = 0; n < 8; n++) {
      body +=
        `\ndef handler_${n}(record):\n    """Process ${area} record type ${n} (validation, defaults, audit)."""\n` +
        `    value = record.get('field_${n}')\n` +
        (used.length ? `    stamp = ${used[n % used.length]}(value)\n` : "    stamp = value\n") +
        "    if stamp is None:\n        raise ValueError('missing value')\n    return {'id': record['id'], 'stamp': stamp}\n";
    }
    writeFileSync(file, `"""${area} module ${String(i).padStart(2, "0")}."""\n\n${header}${body}`, "utf-8");
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** What a Grep tool call returns: path, line number and line, for every match. */
function grep(pattern: RegExp): Array<[string, number, string]> {
  const hits: Array<[string, number, string]> = [];
  for (const file of walk(DEMO_REPO).filter((f) => f.endsWith(".py"))) {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) hits.push([toPosix(path.relative(DEMO_REPO, file)), i + 1, line.trim()]);
      });
  }
  return hits;
}

/** Everything discovery produces: two greps plus a Read of each caller file. */
function discoveryTranscript(): [string, string[]] {
  const importHits = grep(/from common\.legacy_dates import/);
  const callHits = grep(new RegExp(`\\b(${HELPERS.join("|")})\\(`));
  const files = [...new Set(importHits.map((h) => h[0]))].sort();
  const parts = [importHits, callHits].map((hits) => hits.map(([p, n, line]) => `${p}:${n}: ${line}`).join("\n"));
  for (const f of files) parts.push(readFileSync(path.join(DEMO_REPO, f), "utf-8")); // Read of every caller
  return [parts.join("\n"), files];
}

/** What the Explore subagent hands back: one line per caller, nothing else. */
function explorerSummary(files: string[]): string {
  const lines = [`${files.length} callers of common.legacy_dates (helpers used per file):`];
  for (const f of files) {
    const imported = /import (.+)/.exec(readFileSync(path.join(DEMO_REPO, f), "utf-8"));
    lines.push(`- ${f}: ${imported ? imported[1] : "?"}`);
  }
  lines.push("No dynamic imports or re-exports found; every call passes a single ISO string or date.");
  return lines.join("\n");
}

lab.banner("D3.4  Explore subagent: keep verbose discovery out of the main context");
generateRepo();
const [raw, files] = discoveryTranscript();
const summary = explorerSummary(files);

lab.section("Discovery for a 48-file library migration");
const direct = tokens(raw);
const delegated = tokens(summary);
const pct = (n: number) => `${((n / CONTEXT_WINDOW) * 100).toFixed(1)}%`;
console.log(`  callers found: ${files.length}`);
console.log(`  A. discovery in the main conversation : ~${String(direct).padStart(6)} tokens stay in main context (${pct(direct)} of ${CONTEXT_WINDOW.toLocaleString("en-US")})`);
console.log(`  B. discovery in the Explore subagent  : ~${String(delegated).padStart(6)} tokens come back as a summary (${pct(delegated)})`);
console.log(`     (the subagent itself used ~${direct} tokens in ITS OWN context, which is discarded afterwards)`);
console.log("\n  summary returned to the main conversation (first lines):");
console.log(`${summary.split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n")}\n    ...`);

lab.section("Checks");
lab.check(files.length === CALLERS, `discovery found all ${CALLERS} callers and none of the ${UNRELATED} unrelated modules`);
lab.check(delegated < direct * 0.1, "the summary is under 10% of the raw discovery output");
lab.check(files.every((f) => summary.includes(f)), "...and still names every caller, so the plan loses nothing");
