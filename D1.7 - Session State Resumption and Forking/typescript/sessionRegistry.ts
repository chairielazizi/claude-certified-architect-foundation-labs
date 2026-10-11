/**
 * A small persistent registry of named investigation sessions, and the resume-vs-fresh decision.
 *
 *   registry entry   name -> session_id, lineage of earlier ids, content hash of every analysed file
 *                    at the time of analysis, and the findings per file
 *   diff             compare stored hashes with the files on disk now: changed / added / deleted
 *   decide           resume when prior context is mostly valid; start fresh with a structured
 *                    summary when too many earlier tool results describe code that no longer exists
 *
 * The registry is what lets a later work session say *which* files changed, so a resumed session
 * re-reads 1 file instead of re-exploring 4, and a fresh session starts from a summary instead of
 * stale tool output.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STALE_THRESHOLD = 0.5; // more than half of the analysed files changed or deleted -> start fresh

export type Findings = Record<string, string[]>;
export interface Diff {
  changed: string[];
  added: string[];
  deleted: string[];
  unchanged: string[];
}
export interface Entry {
  session_id: string;
  lineage: string[];
  files: Record<string, string>;
  findings: Findings;
}
export interface Decision {
  strategy: "resume" | "fresh";
  stale_ratio: number;
  reason: string;
}

export function hashFiles(root: string, files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((rel) => [rel, createHash("sha256").update(readFileSync(path.join(root, rel))).digest("hex")]));
}

export function diffSnapshot(old: Record<string, string>, now: Record<string, string>): Diff {
  const oldKeys = Object.keys(old);
  return {
    changed: oldKeys.filter((f) => f in now && old[f] !== now[f]).sort(),
    added: Object.keys(now).filter((f) => !(f in old)).sort(),
    deleted: oldKeys.filter((f) => !(f in now)).sort(),
    unchanged: oldKeys.filter((f) => f in now && old[f] === now[f]).sort(),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** "resume" when prior context is mostly valid, "fresh" when tool results are stale. */
export function chooseResumeStrategy(diff: Diff, threshold = STALE_THRESHOLD): Decision {
  const analysed = diff.changed.length + diff.deleted.length + diff.unchanged.length;
  const stale = diff.changed.length + diff.deleted.length;
  const ratio = analysed ? stale / analysed : 1;
  if (ratio > threshold) {
    return {
      strategy: "fresh",
      stale_ratio: ratio,
      reason:
        `${stale}/${analysed} analysed files changed or were deleted (${pct(ratio)} > ${pct(threshold)}): ` +
        "most earlier tool results are stale, so start a new session seeded with a structured summary",
    };
  }
  if (stale || diff.added.length) {
    return {
      strategy: "resume",
      stale_ratio: ratio,
      reason:
        `${stale}/${analysed} analysed files changed (${pct(ratio)}): prior context is mostly valid, ` +
        "so resume and name the changed files for targeted re-analysis",
    };
  }
  return { strategy: "resume", stale_ratio: 0, reason: "nothing changed since the last session: resume as is" };
}

/** The targeted message a resumed session gets instead of "please look at everything again". */
export function buildChangeMessage(diff: Diff): string {
  return [
    "Since our last session these files changed:",
    ...diff.changed.map((f) => `- ${f} (modified)`),
    ...diff.added.map((f) => `- ${f} (added)`),
    ...diff.deleted.map((f) => `- ${f} (deleted: drop its findings)`),
    "Re-analyze only these files and update your findings for them. " +
      "Your earlier analysis of the other files is still valid.",
  ].join("\n");
}

const orNone = (lines: string[]) => (lines.length ? lines : ["- (none)"]);

/** Seed for a fresh session: what still holds, what to re-verify, what to read. No old tool output. */
export function buildStructuredSummary(name: string, entry: Entry, diff: Diff): string {
  const issuesOf = (files: string[]) => files.flatMap((f) => (entry.findings[f] ?? []).map((issue) => `- ${f}: ${issue}`));
  return [
    `STRUCTURED SUMMARY of previous session '${name}' (${entry.session_id}). It replaces that transcript.`,
    "Goal: security review of the auth package.",
    "Still-valid findings (file unchanged since it was analysed):",
    ...orNone(issuesOf(diff.unchanged)),
    "Findings to re-verify (file changed since it was analysed):",
    ...orNone(issuesOf(diff.changed)),
    "Dropped (file deleted):",
    ...orNone(diff.deleted.map((f) => `- ${f}`)),
    "Files to re-read:",
    ...diff.changed.map((f) => `- ${f}`),
    ...diff.added.map((f) => `- ${f} (new)`),
    "Do not rely on any earlier tool results. Read the files above and report updated findings.",
  ].join("\n");
}

/** Carry findings for files that did not change; take fresh results for the re-read ones. */
export function mergeFindings(old: Findings, fresh: Findings, diff: Diff): Findings {
  const merged: Findings = {};
  for (const [f, v] of Object.entries(old)) if (!diff.deleted.includes(f)) merged[f] = v;
  Object.assign(merged, fresh);
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** name -> { session_id, lineage, files (hashes), findings }, persisted as JSON. */
export class SessionRegistry {
  readonly data: Record<string, Entry>;
  private readonly file: string;

  constructor(file: string, reset = false) {
    this.file = file;
    if (reset && existsSync(file)) rmSync(file);
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, Entry>) : {};
  }

  get(name: string): Entry | undefined {
    return this.data[name];
  }

  save(name: string, sessionId: string, files: Record<string, string>, findings: Findings): Entry {
    const previous = this.data[name];
    const lineage = previous ? [...previous.lineage] : [];
    if (previous && previous.session_id !== sessionId) lineage.push(previous.session_id); // keep the trail of sessions behind this name
    this.data[name] = { session_id: sessionId, lineage, files, findings };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf-8");
    return this.data[name];
  }
}
