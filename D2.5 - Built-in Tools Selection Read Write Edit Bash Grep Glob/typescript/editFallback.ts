/**
 * D2.5 - Edit needs a unique anchor; when it cannot get one, fall back to Read + Write.
 *
 * Task: raise the REFUNDS timeout to 45 in config/settings.py, leaving PAYMENTS alone.
 * The line '"timeout_seconds": 30,' appears in BOTH blocks, so:
 *   1. Edit('"timeout_seconds": 30,' -> ...)     fails: 2 matches (ambiguous anchor)
 *   2. Edit with a slightly wrong anchor          fails: 0 matches
 *   3. fallback: Read the whole file, change the line inside the REFUNDS block in memory,
 *      Write the whole file back                  works, and only that one line changes
 *   (A longer anchor that includes the unique '"window_days"' line also makes Edit work;
 *    shown last on a fresh copy. Read + Write is the fallback that always works.)
 *
 * Works on a scratch copy in .lab-runtime/ so sample_repo/ never changes.
 * Always offline. Run:  npx tsx editFallback.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lab from "../../shared/typescript/labkit.ts";
import { EditError, Workspace, lines, readText } from "./miniTools.ts";

const LAB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_REPO = path.join(LAB_DIR, "sample_repo");
const RUNTIME = path.join(LAB_DIR, ".lab-runtime");
const TARGET = "config/settings.py";

/** [payments timeout, refunds timeout] as written in the file. */
function timeouts(text: string): [number, number] {
  const pay = text.match(/PAYMENTS = \{[^}]*"timeout_seconds": (\d+)/);
  const ref = text.match(/REFUNDS = \{[^}]*"timeout_seconds": (\d+)/);
  if (!pay || !ref) throw new Error("settings blocks not found");
  return [Number(pay[1]), Number(ref[1])];
}

/** In-memory edit with full context: only the line inside the REFUNDS block changes. */
function setRefundsTimeout(text: string, value: number): string {
  const rows = text.split("\n");
  let inRefunds = false;
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i];
    if (line.startsWith("REFUNDS = {")) inRefunds = true;
    else if (inRefunds && line.trim().startsWith('"timeout_seconds"')) {
      rows[i] = line.replace(/\d+/, String(value));
      break;
    } else if (inRefunds && line.startsWith("}")) break;
  }
  return rows.join("\n");
}

const errorMessage = (exc: unknown) => (exc instanceof Error ? exc.message : String(exc));

lab.banner("D2.5  Edit's unique-match rule and the Read + Write fallback");
const ws = Workspace.copyOf(SAMPLE_REPO, path.join(RUNTIME, "workspace-ts"));
const original = readText(path.join(ws.root, TARGET));
console.log(`  ${TARGET} before: payments/refunds timeout = ${JSON.stringify(timeouts(original))}`);

lab.section("1. Edit with an ambiguous anchor");
const errors: string[] = [];
try {
  ws.edit(TARGET, '"timeout_seconds": 30,', '"timeout_seconds": 45,');
} catch (exc) {
  if (!(exc instanceof EditError)) throw exc;
  errors.push(errorMessage(exc));
  console.log(`  EditError: ${errorMessage(exc)}`);
}

lab.section("2. Edit with an anchor that is not in the file");
try {
  ws.edit(TARGET, '"timeout_seconds":30', '"timeout_seconds":45');
} catch (exc) {
  if (!(exc instanceof EditError)) throw exc;
  errors.push(errorMessage(exc));
  console.log(`  EditError: ${errorMessage(exc)}`);
}

lab.section("3. Fallback: Read the full file, modify in memory, Write it back");
const text = ws.read(TARGET);
ws.write(TARGET, setRefundsTimeout(text, 45));
const after = readText(path.join(ws.root, TARGET));
const before = lines(original);
const changed = lines(after)
  .map((line, i) => [before[i], line] as [string, string])
  .filter(([a, b]) => a !== b);
console.log(`  after: payments/refunds timeout = ${JSON.stringify(timeouts(after))}`);
console.log(`  changed lines: ${JSON.stringify(changed)}`);
console.log(`  tool calls: ${JSON.stringify(ws.calls)}`);

lab.section("Alternative: a longer, unique anchor (fresh copy)");
const ws2 = Workspace.copyOf(SAMPLE_REPO, path.join(RUNTIME, "workspace-anchor-ts"));
ws2.edit(TARGET, '"window_days": 30,\n    "timeout_seconds": 30,', '"window_days": 30,\n    "timeout_seconds": 45,');
const after2 = readText(path.join(ws2.root, TARGET));
console.log(`  after: payments/refunds timeout = ${JSON.stringify(timeouts(after2))}`);

lab.section("Checks");
lab.check(
  errors.length === 2 && errors[0].includes("2 places") && errors[1].includes("not found"),
  "Edit refuses both an ambiguous (2 matches) and a missing (0 matches) anchor",
);
lab.check(JSON.stringify(timeouts(after)) === "[30,45]", "Read + Write changed only the REFUNDS timeout");
lab.check(changed.length === 1, "exactly one line differs from the original");
lab.check(JSON.stringify(timeouts(after2)) === "[30,45]", "a longer anchor with unique context also works for Edit");
lab.check(JSON.stringify(timeouts(readText(path.join(SAMPLE_REPO, TARGET)))) === "[30,30]", "sample_repo/ itself is untouched (demo ran on a scratch copy)");
