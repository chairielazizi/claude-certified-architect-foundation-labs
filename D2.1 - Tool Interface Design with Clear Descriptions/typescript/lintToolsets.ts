/**
 * D2.1 - Review tool interfaces before the model ever sees them.
 *
 * Runs the three static reviews from toolLint.ts over the "before" and "after" toolsets
 * and both system prompts:
 *   1. description linter   - is each description complete enough to choose by?
 *   2. overlap detector     - which pairs are near-identical (token Jaccard)?
 *   3. prompt keyword lint  - which instructions bind a keyword to a tool?
 *
 * Always offline (no model involved). Run:  npx tsx lintToolsets.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { OVERLAP_THRESHOLD, findOverlaps, lintSystemPrompt, lintToolset, maxSimilarity } from "./toolLint.ts";
import { BAD_TOOLS, GOOD_TOOLS, KEYWORD_TRAP_SYSTEM_PROMPT, RENAMES, REVIEWED_SYSTEM_PROMPT } from "./toolsets.ts";

function printLint(label: string, report: Record<string, string[]>): number {
  lab.section(label);
  let total = 0;
  for (const [name, findings] of Object.entries(report)) {
    console.log(`  ${name}: ${findings.length === 0 ? "clean" : `${findings.length} finding(s)`}`);
    for (const f of findings) console.log(`      - ${f}`);
    total += findings.length;
  }
  return total;
}

lab.banner("D2.1  Tool description, overlap and system-prompt review");

const badReport = lintToolset(BAD_TOOLS);
const goodReport = lintToolset(GOOD_TOOLS);
const badTotal = printLint("1a. Description linter - BAD_TOOLS", badReport);
const goodTotal = printLint("1b. Description linter - GOOD_TOOLS", goodReport);

lab.section(`2. Overlap detector (token Jaccard >= ${OVERLAP_THRESHOLD})`);
const badOverlaps = findOverlaps(BAD_TOOLS);
const goodOverlaps = findOverlaps(GOOD_TOOLS);
console.log(`  BAD_TOOLS  near-identical pairs: ${JSON.stringify(badOverlaps)}`);
console.log(`  GOOD_TOOLS near-identical pairs: ${JSON.stringify(goodOverlaps)}  (max similarity ${maxSimilarity(GOOD_TOOLS).toFixed(2)})`);

lab.section("Rename / split map (old tool <- new tool)");
for (const [newName, oldName] of Object.entries(RENAMES)) {
  if (newName !== oldName) console.log(`  ${oldName.padEnd(17)} <- ${newName}`);
}

lab.section("3. System-prompt keyword review");
const names = GOOD_TOOLS.map((t) => t.name);
const trapFindings = lintSystemPrompt(KEYWORD_TRAP_SYSTEM_PROMPT, names);
const reviewedFindings = lintSystemPrompt(REVIEWED_SYSTEM_PROMPT, names);
console.log(`  keyword-trap prompt: ${JSON.stringify(KEYWORD_TRAP_SYSTEM_PROMPT)}`);
for (const f of trapFindings) console.log(`      - ${f}`);
console.log(`  reviewed prompt: ${reviewedFindings.length} finding(s)`);

lab.section("Checks");
lab.check(badReport["get_customer"].length > 0 && badReport["lookup_order"].length > 0, "minimal one-line descriptions are flagged");
lab.check(
  badReport["analyze_document"].some((f) => f.includes("generic name")),
  "generic analyze_document is flagged for renaming / splitting",
);
lab.check(
  badOverlaps.some(([a, b]) => new Set([a, b]).has("analyze_content") && new Set([a, b]).has("analyze_document")),
  "overlap detector catches analyze_content vs analyze_document",
);
lab.check(goodTotal === 0 && badTotal > 0, `GOOD_TOOLS lint clean (${badTotal} findings before, ${goodTotal} after)`);
lab.check(goodOverlaps.length === 0, "no near-identical description pair remains after rename + split");
lab.check(trapFindings.length === 2 && reviewedFindings.length === 0, "keyword-sensitive instructions found only in the trap prompt");
