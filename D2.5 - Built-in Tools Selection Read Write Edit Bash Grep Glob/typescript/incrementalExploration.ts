/**
 * D2.5 - Build understanding incrementally: Grep for the entry point, Read, follow imports.
 *
 * Question: "When the app checks out a cart, where is the card actually charged?"
 *   1. Grep  for the entry point (__name__ == "__main__")          -> app/main.py
 *   2. Read  app/main.py, see checkout_cart imported from app.checkout
 *   3. Read  app/checkout.py (where checkout_cart is defined); it calls charge()
 *   4. follow 'from app.payments import charge' -> app/payments/__init__.py (a re-export)
 *   5. follow 'from ._stripe_adapter import charge' -> app/payments/_stripe_adapter.py: def charge
 *   6. Grep  the decline message to confirm the provider call lives there (no extra Read)
 *
 * Only the files on the path are read, instead of loading the whole repository upfront.
 * Always offline. Run:  npx tsx incrementalExploration.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";
import { parseImports, resolveModule } from "./codeNav.ts";
import { Workspace, readText } from "./miniTools.ts";

const SAMPLE_REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sample_repo");

/** Follow `symbol` through import / re-export / alias chains to its definition. */
function trace(ws: Workspace, symbol: string, file: string, steps: string[], seen: Map<string, string>): string {
  const source = seen.get(file) ?? ws.read(file); // don't re-Read a file already in context
  seen.set(file, source);
  if (new RegExp(`^\\s*def ${symbol}\\(`, "m").test(source)) {
    steps.push(`${file}: def ${symbol}(...)  <- defined here`);
    return file;
  }
  const imported = parseImports(source).get(symbol);
  if (!imported) throw new Error(`${symbol} is neither defined nor imported in ${file}`);
  const [module, original] = imported;
  const target = resolveModule(module, file, ws.allFiles());
  if (!target) throw new Error(`cannot resolve ${module} from ${file}`);
  const alias = original !== symbol ? ` (alias of ${original})` : "";
  steps.push(`${file}: ${symbol}${alias} imported from ${module} -> ${target}`);
  return trace(ws, original, target, steps, seen);
}

lab.banner("D2.5  Incremental exploration: Grep -> Read -> follow imports");
const ws = new Workspace(SAMPLE_REPO);
const everything = ws.allFiles();
const steps: string[] = [];
const seen = new Map<string, string>();

lab.section("Step 1: Grep for the entry point");
const entryHits = ws.grep('__name__ == "__main__"');
const entry = entryHits[0][0];
console.log(`  ${JSON.stringify(entryHits)}`);

lab.section("Steps 2-5: Read and follow imports");
const mainSource = ws.read(entry);
seen.set(entry, mainSource);
const mainImports = parseImports(mainSource);
const called = [...mainSource.matchAll(/(\w+)\(/g)].map((m) => m[1]).filter((name) => mainImports.has(name));
console.log(`  ${entry} calls imported: ${JSON.stringify(called)}`);
const checkoutFile = trace(ws, called[0], entry, steps, seen);
const chargeFile = trace(ws, "charge", checkoutFile, steps, seen);
for (const step of steps) console.log(`  ${step}`);

lab.section("Step 6: confirm with Grep (no extra Read)");
const decline = ws.grep("Card declined");
console.log(`  ${JSON.stringify(decline)}`);

lab.section("What was loaded");
const read = [...new Set(ws.filesRead)];
const charsRead = read.reduce((n, f) => n + (seen.get(f) ?? "").length, 0);
const charsAll = everything.reduce((n, f) => n + readText(path.join(SAMPLE_REPO, f)).length, 0);
console.log(`  tool calls: ${JSON.stringify(ws.calls)}`);
console.log(`  files read: ${read.length}/${everything.length}  chars read: ${charsRead}/${charsAll} (${Math.round((charsRead / charsAll) * 100)}%)`);

lab.section("Checks");
lab.check(entry === "app/main.py", "Grep found the entry point without opening any file");
lab.check(chargeFile === "app/payments/_stripe_adapter.py", "followed main -> checkout -> payments/__init__ (re-export) -> _stripe_adapter");
lab.check(decline.length > 0 && decline[0][0] === chargeFile, "the decline error message confirms the provider call site");
lab.check(read.length === 4 && read.length < everything.length / 4, `read only the ${read.length} files on the path, not all ${everything.length}`);
lab.check(charsRead < 0.4 * charsAll, "a fraction of the repository's text entered the context");
