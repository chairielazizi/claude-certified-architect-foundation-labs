/**
 * Tiny re-implementations of Claude Code's file tools, with the same contracts (D2.5).
 *
 *   grep(pattern, glob?)  CONTENT search: regex over file contents -> [path, lineNo, line]
 *   glob(pattern)         PATH matching: "** /*.test.tsx" style -> matching file paths, no contents
 *   read(path)            full file contents (counted, so demos can show how much was read)
 *   write(path, content)  create or fully replace a file
 *   edit(path, old, new)  targeted replace; `old` must match EXACTLY ONCE, otherwise it fails
 *                         (0 matches: anchor wrong; >1: anchor ambiguous)
 *
 * The real tools have more options; these keep the behaviour that drives tool choice.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export class EditError extends Error {}

/** Read as text with LF line endings (a Windows checkout may have CRLF). */
export function readText(file: string): string {
  return readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
}

/** Lines of a text, without the empty string a trailing newline would add. */
export function lines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/** '** /' = any number of directories (including none), '*' = within one path segment. */
export function globToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export type GrepHit = [path: string, lineNo: number, line: string];

export class Workspace {
  readonly root: string;
  readonly filesRead: string[] = [];
  readonly calls: string[] = []; // tool-call log: "Grep ...", "Read ...", ...

  constructor(root: string) {
    this.root = root;
  }

  /** A fresh scratch copy (for demos that modify files) so reruns are deterministic. */
  static copyOf(source: string, runtimeDir: string): Workspace {
    if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(path.dirname(runtimeDir), { recursive: true });
    cpSync(source, runtimeDir, { recursive: true, filter: (src) => !src.includes("__pycache__") });
    return new Workspace(runtimeDir);
  }

  allFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__pycache__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    walk(this.root);
    return out.sort();
  }

  glob(pattern: string): string[] {
    this.calls.push(`Glob ${pattern}`);
    const regex = globToRegex(pattern);
    return this.allFiles().filter((f) => regex.test(f));
  }

  grep(pattern: string, glob?: string): GrepHit[] {
    this.calls.push(`Grep ${pattern}` + (glob ? ` (glob ${glob})` : ""));
    const regex = new RegExp(pattern);
    const scope = glob ? globToRegex(glob) : null;
    const hits: GrepHit[] = [];
    for (const rel of this.allFiles()) {
      if (scope && !scope.test(rel)) continue;
      lines(readText(path.join(this.root, rel))).forEach((line, idx) => {
        if (regex.test(line)) hits.push([rel, idx + 1, line.trim()]);
      });
    }
    return hits;
  }

  read(file: string): string {
    this.calls.push(`Read ${file}`);
    this.filesRead.push(file);
    return readText(path.join(this.root, file));
  }

  write(file: string, content: string): void {
    this.calls.push(`Write ${file}`);
    const target = path.join(this.root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf-8");
  }

  edit(file: string, oldText: string, newText: string): void {
    this.calls.push(`Edit ${file}`);
    const target = path.join(this.root, file);
    const text = readText(target);
    const count = text.split(oldText).length - 1;
    if (count === 0) throw new EditError(`old_string not found in ${file}`);
    if (count > 1) throw new EditError(`old_string matches ${count} places in ${file}; provide more context to make it unique`);
    writeFileSync(target, text.replace(oldText, () => newText), "utf-8");
  }
}
