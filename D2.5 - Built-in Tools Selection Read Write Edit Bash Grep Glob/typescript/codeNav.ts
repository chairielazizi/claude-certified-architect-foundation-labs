/**
 * Small helpers for following Python imports in sample_repo (D2.5).
 *
 * These are what an agent does "in its head" after a Read: look at the import lines, work
 * out which file a name comes from, and decide what to open next.
 */
import path from "node:path";

const FROM_IMPORT = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/;

/** "from m import a as b, c" -> [["a", "b"], ["c", "c"]]  (original, local name). */
export function importedNames(line: string): [string, string][] {
  const match = line.match(FROM_IMPORT);
  if (!match) return [];
  const names = match[2].split("#")[0].replace(/[()]/g, "");
  const pairs: [string, string][] = [];
  for (const part of names.split(",")) {
    const bits = part.trim().split(/\s+/).filter((b) => b.length > 0);
    if (bits.length === 3 && bits[1] === "as") pairs.push([bits[0], bits[2]]);
    else if (bits.length === 1) pairs.push([bits[0], bits[0]]);
  }
  return pairs;
}

/** local name -> [module, original name] for every from-import in a file. */
export function parseImports(source: string): Map<string, [string, string]> {
  const found = new Map<string, [string, string]>();
  for (const line of source.split("\n")) {
    const match = line.match(FROM_IMPORT);
    if (!match) continue;
    for (const [original, local] of importedNames(line)) found.set(local, [match[1], original]);
  }
  return found;
}

/** Module path (absolute or relative) -> the repo file that defines it. */
export function resolveModule(module: string, fromFile: string, files: string[]): string | null {
  let parts: string[];
  if (module.startsWith(".")) {
    const rest = module.replace(/^\.+/, "");
    const level = module.length - rest.length;
    let base = path.posix.dirname(fromFile);
    for (let i = 0; i < level - 1; i++) base = path.posix.dirname(base);
    const baseParts = base === "." ? [] : base.split("/");
    parts = rest ? [...baseParts, ...rest.split(".")] : baseParts;
  } else {
    parts = module.split(".");
  }
  const stem = parts.join("/");
  for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) if (files.includes(candidate)) return candidate;
  return null;
}
