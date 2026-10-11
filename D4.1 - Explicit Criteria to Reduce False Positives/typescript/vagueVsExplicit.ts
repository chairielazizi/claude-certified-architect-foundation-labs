/**
 * D4.1 - The same diff reviewed with vague, "be conservative", and explicit-criteria prompts.
 *
 *   vague          "check that comments are accurate"          -> style nits + wording nitpicks
 *   conservative   "+ only report high-confidence findings"    -> still noisy (model is confident)
 *   explicit       REPORT bug/security/... SKIP style/patterns -> only real issues
 *                  + severity rubric with code examples        -> consistent severities
 *
 * Run:  npx tsx vagueVsExplicit.ts          (offline, scripted reviewer)
 *       npx tsx vagueVsExplicit.ts --live   (real Claude API, same diff and prompts)
 */
import { readFileSync } from "node:fs";
import * as lab from "../../shared/typescript/labkit.ts";
import {
  FINDINGS_SCHEMA,
  FIXTURES,
  ReviewOutput,
  buildConservativePrompt,
  buildExplicitPrompt,
  buildVaguePrompt,
  pct,
  type Finding,
} from "./reviewCriteria.ts";
import { OBSERVATIONS, scriptedReviewer, type Observation } from "./scriptedReviewer.ts";

const DIFF = readFileSync(new URL("sample_diff.txt", FIXTURES), "utf-8");

async function review(client: lab.MessagesClient, system: string): Promise<ReviewOutput> {
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system,
    // Structured output keeps the comparison about WHICH findings are reported,
    // not about whether the JSON parses (that is D4.3's topic).
    output_config: { format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
    messages: [{ role: "user", content: `Review this diff:\n<diff>\n${DIFF}\n</diff>` }],
  });
  return ReviewOutput.parse(JSON.parse(lab.textOf(response)));
}

/** Match a finding to the audited observation on (about) the same line. */
function labelOf(finding: Finding): Observation | null {
  const candidates = OBSERVATIONS.filter((o) => Math.abs(o.line - finding.line) <= 1);
  const sameCat = candidates.filter((o) => o.category === finding.category);
  return sameCat[0] ?? candidates[0] ?? null;
}

interface Score {
  reported: number;
  true_positives: number;
  precision: number;
  recall: number;
  categories: string[];
  severity_matches_rubric: boolean;
}

function score(output: ReviewOutput): Score {
  const matched = output.findings.map((f) => ({ f, o: labelOf(f) }));
  const tp = matched.filter(({ o }) => o !== null && o.label === "true_positive");
  const realTotal = OBSERVATIONS.filter((o) => o.label === "true_positive").length;
  return {
    reported: output.findings.length,
    true_positives: tp.length,
    precision: output.findings.length ? tp.length / output.findings.length : 1,
    recall: tp.length / realTotal,
    categories: [...new Set(output.findings.map((f) => f.category))].sort(),
    severity_matches_rubric: matched.every(({ f, o }) => o !== null && f.severity === o.rubric_severity),
  };
}

lab.banner("D4.1  Vague instructions vs explicit review criteria");
const variants: Record<string, string> = {
  vague: buildVaguePrompt(),
  conservative: buildConservativePrompt(),
  explicit: buildExplicitPrompt(),
  "explicit, comment_accuracy off": buildExplicitPrompt({ comment_accuracy: false }),
};
const results: Record<string, Score> = {};
for (const [name, system] of Object.entries(variants)) {
  lab.section(`prompt: ${name}`);
  const output = await review(lab.getClient(scriptedReviewer), system);
  for (const f of output.findings) {
    console.log(`  line ${String(f.line).padStart(2)}  ${f.category.padEnd(17)} ${f.severity.padEnd(8)} ${f.issue.slice(0, 70)}`);
  }
  const s = (results[name] = score(output));
  console.log(
    `  -> ${s.reported} findings, precision ${pct(s.precision)}, recall ${pct(s.recall)}, ` +
      `severities match rubric: ${s.severity_matches_rubric}`,
  );
}

lab.section("Comparison");
console.log(`  ${"prompt".padEnd(32)}${"findings".padStart(9)}${"precision".padStart(11)}${"recall".padStart(8)}`);
for (const [name, s] of Object.entries(results)) {
  console.log(`  ${name.padEnd(32)}${String(s.reported).padStart(9)}${pct(s.precision).padStart(11)}${pct(s.recall).padStart(8)}`);
}

if (!lab.isLive()) {
  const vague = results.vague;
  const cons = results.conservative;
  const expl = results.explicit;
  const off = results["explicit, comment_accuracy off"];
  lab.check(vague.precision < 0.5 && vague.categories.includes("style"), "vague prompt: style nits and wording nitpicks, precision < 50%");
  lab.check(
    cons.precision < 0.5 && cons.categories.includes("style"),
    "'be conservative / high-confidence only' barely helps: the model is confident about nits",
  );
  lab.check(expl.precision === 1 && expl.recall === 1, "explicit criteria: every real issue, nothing else");
  lab.check(
    !expl.categories.some((c) => c === "style" || c === "local_pattern"),
    "SKIP categories (minor style, local patterns) are not reported",
  );
  lab.check(
    expl.severity_matches_rubric && !vague.severity_matches_rubric,
    "the severity rubric with code examples gives consistent severities; vague prompt does not",
  );
  lab.check(
    !off.categories.includes("comment_accuracy") && off.precision === 1,
    "toggling comment_accuracy off removes that category only (recall drops, precision holds)",
  );
}
