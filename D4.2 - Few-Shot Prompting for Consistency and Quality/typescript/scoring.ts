/** Scorers for D4.2: is the output in the required format, and are required fields filled? */
import { z } from "zod";
import type { ResearchDoc } from "./fewshotPrompts.ts";

// strictObject: a finding with "line"/"problem"/"level" keys is a format failure, not a pass.
export const ReviewFinding = z.strictObject({
  location: z.string(),
  issue: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  suggested_fix: z.string(),
});

export const Measurement = z.strictObject({
  quantity: z.number().nullable(),
  unit: z.string(),
  approximate: z.boolean(),
  original_text: z.string(),
});

export const PaperExtraction = z.strictObject({
  title: z.string(),
  methodology: z.string().nullable(),
  citations: z.array(z.string()),
  measurements: z.array(Measurement),
});
export type PaperExtraction = z.infer<typeof PaperExtraction>;

/** [ok, reason]: output must be a JSON array whose items all match ReviewFinding exactly. */
export function conforms(outputText: string): [boolean, string] {
  let data: unknown;
  try {
    data = JSON.parse(outputText);
  } catch {
    return [false, "not JSON"];
  }
  if (!Array.isArray(data)) return [false, `JSON ${data === null ? "null" : typeof data}, not an array`];
  for (const item of data) {
    const parsed = ReviewFinding.safeParse(item);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return [false, `${first.path.join(".")}: ${first.message}`];
    }
  }
  return [true, "ok"];
}

export function formatConsistency(outputs: string[]): number {
  return outputs.filter((o) => conforms(o)[0]).length / outputs.length;
}

/** Lenient count used for FP/recall scoring, so prose answers are still judged on substance. */
export function findingCount(outputText: string): number {
  const text = outputText.trim();
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data.length : 1;
  } catch {
    return !text || text.toLowerCase().includes("no issues") ? 0 : 1;
  }
}

/** Lenient parse (live replies may wrap JSON in prose or fences); null if unusable. */
export function parseExtraction(outputText: string): PaperExtraction | null {
  const start = outputText.indexOf("{");
  const end = outputText.lastIndexOf("}");
  try {
    const parsed = PaperExtraction.safeParse(JSON.parse(outputText.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Required fields that came back null/empty although the document contains them. */
export function missingRequired(extraction: PaperExtraction | null, expected: ResearchDoc["expected"]): string[] {
  if (extraction === null) {
    return (["methodology", "citations", "measurements"] as const).filter((k) => Boolean(expected[k]));
  }
  const missing: string[] = [];
  if (expected.methodology && !extraction.methodology) missing.push("methodology");
  if (expected.citations && !extraction.citations.length) missing.push("citations");
  if (expected.measurements && !extraction.measurements.length) missing.push("measurements");
  return missing;
}
