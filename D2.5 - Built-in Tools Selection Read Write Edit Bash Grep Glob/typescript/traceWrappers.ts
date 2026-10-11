/**
 * D2.5 - Trace function usage across wrapper modules: collect every exported name first.
 *
 * Task: "find every place that moves money through core.refund / the card adapter's charge".
 *   naive:        Grep the function name once ("\brefund\(")
 *                 -> misses callers that use a re-exported alias (issue_refund, capture_payment)
 *   alias-aware:  1. Grep import lines for the name and collect every alias / re-export
 *                    (refunds.py: 'from .core import refund as issue_refund'), repeat for each
 *                    new alias until no new names appear
 *                 2. Grep for calls of EACH name
 *
 * Always offline. Run:  npx tsx traceWrappers.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";
import { importedNames } from "./codeNav.ts";
import { Workspace } from "./miniTools.ts";

const SAMPLE_REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample_repo");

/** Every name the function is reachable under, found from import / re-export lines. */
function exportedNames(ws: Workspace, name: string): { names: Set<string>; evidence: string[] } {
  const names = new Set([name]);
  const frontier = [name];
  const evidence: string[] = [];
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const [file, lineNo, line] of ws.grep(`import .*\\b${current}\\b`)) {
      for (const [original, local] of importedNames(line)) {
        if (original === current && !names.has(local)) {
          names.add(local);
          frontier.push(local);
          evidence.push(`${file}:${lineNo}  ${line}`);
        }
      }
    }
  }
  return { names, evidence };
}

function callSites(ws: Workspace, names: Set<string>): string[] {
  const hits: string[] = [];
  for (const name of [...names].sort()) {
    for (const [file, n, line] of ws.grep(`\\b${name}\\(`)) if (!line.startsWith("def ")) hits.push(`${file}:${n}`);
  }
  return [...new Set(hits)].sort();
}

lab.banner("D2.5  Tracing usage across wrapper modules and aliases");
const ws = new Workspace(SAMPLE_REPO);
const results: Record<string, { naive: Set<string>; aware: Set<string>; names: Set<string> }> = {};
for (const target of ["refund", "charge"]) {
  lab.section(`Who calls ${target}()?`);
  const naive = callSites(ws, new Set([target]));
  const { names, evidence } = exportedNames(ws, target);
  const aware = callSites(ws, names);
  console.log(`  naive Grep '\\b${target}\\(':  ${JSON.stringify(naive)}`);
  console.log(`  names found from import lines: ${JSON.stringify([...names].sort())}`);
  for (const line of evidence) console.log(`      ${line}`);
  console.log(`  alias-aware Grep:  ${JSON.stringify(aware)}`);
  console.log(`  missed by the naive search: ${JSON.stringify(aware.filter((s) => !naive.includes(s)))}`);
  results[target] = { naive: new Set(naive), aware: new Set(aware), names };
}

const sameSet = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));
const missed = (r: { naive: Set<string>; aware: Set<string> }) => [...r.aware].filter((s) => !r.naive.has(s));

lab.section("Checks");
const r = results.refund;
lab.check(sameSet(r.names, ["refund", "issue_refund"]), "refund is also exported as issue_refund (refunds.py wrapper)");
lab.check([...r.naive].every((s) => r.aware.has(s)) && r.aware.size > r.naive.size, "alias-aware search finds strictly more call sites than the naive one");
const missedFiles = new Set(missed(r).map((s) => s.split(":")[0]));
lab.check(missedFiles.has("app/checkout.py") && missedFiles.has("app/admin/tools.py"), "checkout.py and admin/tools.py (refunds.issue_refund) were invisible to the naive Grep");
const c = results.charge;
lab.check(sameSet(c.names, ["charge", "capture_payment"]), "charge is re-exported by payments/__init__.py, once under an alias");
lab.check(missed(c).some((s) => s.startsWith("app/jobs/reconcile.py")), "the reconcile job's capture_payment() call is found only via the alias");
