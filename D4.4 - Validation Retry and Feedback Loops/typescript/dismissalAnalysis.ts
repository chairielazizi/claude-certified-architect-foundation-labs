/**
 * D4.4 - Feedback loop: detected_pattern on every finding makes dismissals analysable.
 *
 *   reviewer emits {category, detected_pattern, message}
 *   developers accept / dismiss
 *   dismissal rate per detected_pattern -> the exact construct that produces false positives
 *   (per category the signal is diluted: "bug" mixes great patterns with noisy ones)
 *
 * Pure analysis over fixtures/review_history.json (simulated developer feedback); no model calls.
 *
 * Run:  npx tsx dismissalAnalysis.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";
import * as lab from "../../shared/typescript/labkit.ts";

// The reviewer's output tool: detected_pattern is a first-class, required field.
const REPORT_FINDING_TOOL: Anthropic.Tool = {
  name: "report_finding",
  description: "Report one review finding.",
  input_schema: {
    type: "object",
    properties: {
      file: { type: "string" },
      category: { type: "string", enum: ["bug", "security", "performance", "style"] },
      detected_pattern: {
        type: "string",
        description:
          "kebab-case name of the code construct that triggered the finding, e.g. " +
          "'broad-except-reraise', 'sql-string-format'. Reuse an existing name when the construct is the same.",
      },
      message: { type: "string" },
    },
    required: ["file", "category", "detected_pattern", "message"],
  },
};

const ReviewFinding = z.strictObject({
  id: z.string(),
  file: z.string(),
  category: z.enum(["bug", "security", "performance", "style"]),
  detected_pattern: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  message: z.string(),
  developer_action: z.enum(["accepted", "dismissed"]),
});
type ReviewFinding = z.infer<typeof ReviewFinding>;

interface Rate {
  n: number;
  dismissed: number;
  rate: number;
}

function dismissalRates(findings: ReviewFinding[], key: "category" | "detected_pattern"): Record<string, Rate> {
  const rates: Record<string, Rate> = {};
  for (const f of findings) {
    const r = (rates[f[key]] ??= { n: 0, dismissed: 0, rate: 0 });
    r.n += 1;
    if (f.developer_action === "dismissed") r.dismissed += 1;
  }
  for (const r of Object.values(rates)) r.rate = r.dismissed / r.n;
  return Object.fromEntries(Object.entries(rates).sort((a, b) => b[1].rate - a[1].rate));
}

/** Enough evidence AND mostly dismissed. Small samples are watched, not acted on. */
function flag(rates: Record<string, Rate>, minSamples = 5, threshold = 0.7): string[] {
  return Object.entries(rates)
    .filter(([, r]) => r.n >= minSamples && r.rate >= threshold)
    .map(([k]) => k);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function printRates(title: string, rates: Record<string, Rate>, flagged: string[]): void {
  console.log(`  ${title.padEnd(24)}${"n".padStart(4)}${"dismissed".padStart(11)}${"rate".padStart(7)}`);
  for (const [k, r] of Object.entries(rates)) {
    const mark = flagged.includes(k) ? "  <- false-positive source" : "";
    console.log(`  ${k.padEnd(24)}${String(r.n).padStart(4)}${String(r.dismissed).padStart(11)}${pct(r.rate).padStart(7)}${mark}`);
  }
}

lab.banner("D4.4  Dismissal analysis by detected_pattern");
const raw = (JSON.parse(readFileSync(new URL("../fixtures/review_history.json", import.meta.url), "utf-8")) as { findings: unknown[] }).findings;
const findings = raw.map((f) => ReviewFinding.parse(f));
const props = REPORT_FINDING_TOOL.input_schema.properties as Record<string, unknown>;
lab.show("reviewer output schema: detected_pattern", props.detected_pattern);

lab.section("1. Overall");
const overall = findings.filter((f) => f.developer_action === "dismissed").length / findings.length;
console.log(`  ${findings.length} findings, ${pct(overall)} dismissed. Something is noisy, but what?`);

lab.section("2. By category (what you get without detected_pattern)");
const byCategory = dismissalRates(findings, "category");
const categoryFlags = flag(byCategory);
printRates("category", byCategory, categoryFlags);

lab.section("3. By detected_pattern");
const byPattern = dismissalRates(findings, "detected_pattern");
const patternFlags = flag(byPattern);
printRates("detected_pattern", byPattern, patternFlags);

lab.section("4. What to change");
const fixes: Record<string, string> = {
  "broad-except-reraise":
    "add an explicit criterion + an acceptable-pattern example: logging and re-raising is NOT an issue (keep R-19's 'loses the cause' case)",
  "magic-number-in-test": "add a SKIP rule: literal values in tests/** are expected data, not magic numbers",
};
for (const p of patternFlags) console.log(`  ${p}: ${fixes[p] ?? "review the criterion that produces it"}`);
const kept = findings.filter((f) => !patternFlags.includes(f.detected_pattern));
const projected = kept.filter((f) => f.developer_action === "dismissed").length / kept.length;
console.log(`  dismissal rate without those patterns: ${pct(overall)} -> ${pct(projected)}`);

lab.check(findings.length === 36, "every finding validated with a detected_pattern field");
lab.check(
  !categoryFlags.includes("bug") && byCategory.bug.rate > 0.3 && byCategory.bug.rate < 0.7,
  "per category, 'bug' looks merely mixed: the noisy construct is hidden inside it",
);
lab.check(
  patternFlags.length === 2 && patternFlags.includes("broad-except-reraise") && patternFlags.includes("magic-number-in-test"),
  "per pattern, the two false-positive constructs stand out",
);
lab.check(byPattern["unbounded-retry-loop"].rate === 0, "...while other 'bug' patterns are fully trusted and must be kept");
lab.check(!patternFlags.includes("mutable-default-arg"), "a 3-sample pattern is not acted on (minimum sample size)");
lab.check(projected < overall / 2, "fixing two criteria more than halves the dismissal rate");
