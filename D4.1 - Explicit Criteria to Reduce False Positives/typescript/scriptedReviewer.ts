/**
 * Offline stand-in for Claude as a code reviewer (D4.1).
 *
 * It "notices" everything in fixtures/diff_observations.json whose evidence appears in the
 * diff it was sent, then lets the SYSTEM PROMPT decide what to report - the way the real
 * model's output depends on how explicit the instructions are:
 *  - no REPORT/SKIP criteria   -> reports everything it noticed (style nits included)
 *  - "only high-confidence"     -> drops only what it feels unsure about; it is very sure
 *                                 about style nits, so they stay (why the advice fails)
 *  - explicit REPORT/SKIP lists -> reports only listed categories; for comment_accuracy it
 *                                 honours the "contradicts the code" criterion
 *  - SEVERITY RUBRIC present    -> uses the rubric level; otherwise picks inconsistently
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { loadJson } from "./reviewCriteria.ts";

export interface Observation {
  id: string;
  line: number;
  category: string;
  evidence: string;
  issue: string;
  contradicts_code: boolean;
  label: "true_positive" | "false_positive";
  rubric_severity: string;
  unguided_severity: string;
  self_confidence: number;
}

export const OBSERVATIONS: Observation[] = loadJson<{ observations: Observation[] }>("diff_observations.json").observations;

/** Parse "- name: text" lines that follow a header line, up to the next blank line. */
function bulletBlock(system: string, header: string): Record<string, string> {
  if (!system.includes(header)) return {};
  const block = system.split(header)[1].split("\n\n")[0];
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/^- (\w+): (.*)$/gm)) out[m[1]] = m[2];
  return out;
}

export function scriptedReviewer(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  const diff = lab.lastUserText(params);
  const noticed = OBSERVATIONS.filter((o) => diff.includes(o.evidence));

  const report = bulletBlock(system, "REPORT only these categories:");
  const explicit = Object.keys(report).length > 0;
  const confidenceFilter = system.toLowerCase().includes("high-confidence");
  const hasRubric = system.includes("SEVERITY RUBRIC");

  const findings: Record<string, unknown>[] = [];
  for (const obs of noticed) {
    if (explicit) {
      if (!(obs.category in report)) continue; // listed under SKIP, disabled, or not asked for
      if (obs.category === "comment_accuracy" && report.comment_accuracy.includes("contradicts") && !obs.contradicts_code) {
        continue; // imprecise wording is not a contradiction
      }
    } else if (confidenceFilter && obs.self_confidence < 0.7) {
      continue; // the model only drops what it *feels* unsure about
    }
    findings.push({
      line: obs.line,
      category: obs.category,
      severity: hasRubric ? obs.rubric_severity : obs.unguided_severity,
      issue: obs.issue,
    });
  }
  return lab.message([lab.text(JSON.stringify({ findings }))]);
}
