/**
 * Review prompts for D4.1: vague instructions vs explicit categorical criteria.
 *
 * The explicit prompt is generated from data (categories, toggles, severity rubric) so a team
 * can switch a noisy category off for a while without hand-editing prose, and so the prompt
 * and the precision report always agree on what each category means.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const FIXTURES = new URL("../fixtures/", import.meta.url);

export function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf-8")) as T;
}

export const SEVERITIES = ["critical", "high", "medium", "low"];

// Each category says exactly WHAT qualifies. "report" categories can be toggled off;
// "skip" categories are permanent exclusions (style, patterns the codebase already uses).
export const CATEGORIES: Record<string, { action: "report" | "skip"; criterion: string }> = {
  bug: {
    action: "report",
    criterion: "Code that produces a wrong result, a crash or data loss on a realistic input. Name the input.",
  },
  security: {
    action: "report",
    criterion: "Injection, auth bypass, secret exposure or unsafe deserialization reachable from untrusted input.",
  },
  performance: {
    action: "report",
    criterion: "Only when the complexity class changes on realistic data (N+1 queries, quadratic loops over unbounded input).",
  },
  comment_accuracy: {
    action: "report",
    // The exam's example of an explicit criterion: contradiction, not "accuracy".
    criterion:
      "Flag a comment ONLY when the behavior it claims contradicts what the code actually does " +
      "(e.g. it says 'returns None' but the code raises). Do not flag comments that are terse, " +
      "incomplete or imprecise.",
  },
  style: {
    action: "skip",
    criterion: "Naming, formatting, missing type hints or docstrings, line length.",
  },
  local_pattern: {
    action: "skip",
    criterion: "Code that follows a pattern already used consistently in this codebase, even if you would design it differently.",
  },
};

// Severity levels defined by a concrete code example each, so two reviewers (or two runs)
// put the same issue in the same bucket.
export const SEVERITY_RUBRIC: { level: string; definition: string; example: string }[] = [
  {
    level: "critical",
    definition: "Exploitable security flaw or silent data loss.",
    example: "query = f\"SELECT * FROM users WHERE id = '{user_id}'\"",
  },
  { level: "high", definition: "Wrong result on a normal, common path.", example: "pages = rows // PAGE_SIZE   # last partial page is never shown" },
  {
    level: "medium",
    definition: "Wrong only in an edge case, or a comment that contradicts the code so callers will misuse it.",
    example: "# returns None if missing\nreturn cache[key]   # actually raises KeyError",
  },
  { level: "low", definition: "Real but minor; no wrong result.", example: "data = open(path).read()   # handle never closed in a long-running worker" },
];

// Toggles cover the "report" categories. Flip one to false to stop reporting it while its
// criterion is being rewritten; it moves to the SKIP list with a note.
export const DEFAULT_TOGGLES: Record<string, boolean> = Object.fromEntries(
  Object.entries(CATEGORIES)
    .filter(([, c]) => c.action === "report")
    .map(([name]) => [name, true]),
);

export const OUTPUT_INSTRUCTIONS =
  'Respond with JSON only: {"findings": [{"line": <int>, "category": <category>, ' +
  '"severity": "critical|high|medium|low", "issue": <one sentence>}]}. ' +
  'Return {"findings": []} when nothing qualifies.';

// JSON schema for output_config.format in live mode (guarantees parseable JSON so the
// comparison is about WHICH findings come back, not about formatting).
export const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "integer" },
          category: { type: "string", enum: Object.keys(CATEGORIES) },
          severity: { type: "string", enum: SEVERITIES },
          issue: { type: "string" },
        },
        required: ["line", "category", "severity", "issue"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

export const Finding = z.strictObject({
  line: z.number().int(),
  category: z.enum(["bug", "security", "performance", "comment_accuracy", "style", "local_pattern"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  issue: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewOutput = z.strictObject({ findings: z.array(Finding) });
export type ReviewOutput = z.infer<typeof ReviewOutput>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/** What teams usually start with: sounds reasonable, defines nothing. */
export function buildVaguePrompt(): string {
  return (
    "You are reviewing a pull request diff. Look for bugs, security problems and anything else " +
    "worth improving. Check that comments are accurate. Assign each finding a severity.\n\n" +
    OUTPUT_INSTRUCTIONS
  );
}

/** The usual "fix" for noise: ask for caution. It does not say WHAT to skip. */
export function buildConservativePrompt(): string {
  return (
    buildVaguePrompt().replace(OUTPUT_INSTRUCTIONS, "") +
    "Be conservative. Only report high-confidence findings.\n\n" +
    OUTPUT_INSTRUCTIONS
  );
}

/** Categorical REPORT/SKIP criteria + severity rubric with a code example per level. */
export function buildExplicitPrompt(toggles: Record<string, boolean> = {}): string {
  const on = { ...DEFAULT_TOGGLES, ...toggles };
  const names = Object.keys(CATEGORIES);
  const report = names.filter((n) => CATEGORIES[n].action === "report" && on[n] !== false);
  const disabled = names.filter((n) => CATEGORIES[n].action === "report" && on[n] === false);
  const skip = names.filter((n) => CATEGORIES[n].action === "skip");

  const lines = [
    "You are reviewing a pull request diff. Report only issues that meet the criteria below.",
    "",
    "REPORT only these categories:",
    ...report.map((n) => `- ${n}: ${CATEGORIES[n].criterion}`),
    "",
    "SKIP (do not report these, even when you are confident):",
    ...skip.map((n) => `- ${n}: ${CATEGORIES[n].criterion}`),
    ...disabled.map((n) => `- ${n}: temporarily disabled while its criteria are being improved.`),
    "",
    "SEVERITY RUBRIC (pick the level whose example is closest):",
  ];
  for (const level of SEVERITY_RUBRIC) {
    const example = level.example.replace(/\n/g, "\n      ");
    lines.push(`- ${level.level}: ${level.definition}\n    e.g. ${example}`);
  }
  lines.push("", OUTPUT_INSTRUCTIONS);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Precision metrics
// ---------------------------------------------------------------------------

export interface LabelledFinding {
  id: string;
  week: number;
  category: string;
  file: string;
  summary: string;
  label: "true_positive" | "false_positive";
  developer_action: "fixed" | "dismissed";
}

export interface CategoryStats {
  reported: number;
  true_positives: number;
  precision: number;
}

export function precisionByCategory(findings: { category: string; label: string }[]): Record<string, CategoryStats> {
  const stats: Record<string, CategoryStats> = {};
  for (const f of findings) {
    const s = (stats[f.category] ??= { reported: 0, true_positives: 0, precision: 0 });
    s.reported += 1;
    if (f.label === "true_positive") s.true_positives += 1;
  }
  for (const s of Object.values(stats)) s.precision = s.true_positives / s.reported;
  return stats;
}

export function overallPrecision(findings: { category: string; label: string }[], include?: Set<string>): number {
  const kept = findings.filter((f) => !include || include.has(f.category));
  return kept.length ? kept.filter((f) => f.label === "true_positive").length / kept.length : 1;
}

/** Categories with enough data AND precision below the bar. Small samples are left alone. */
export function categoriesToDisable(stats: Record<string, CategoryStats>, minPrecision = 0.6, minSamples = 5): string[] {
  return Object.entries(stats)
    .filter(([, s]) => s.reported >= minSamples && s.precision < minPrecision)
    .map(([n]) => n)
    .sort();
}

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
