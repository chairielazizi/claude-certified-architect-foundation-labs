/**
 * D4.2 - Few-shot examples for consistent review output and fewer false positives.
 *
 *   zero-shot (detailed instructions only) -> format drifts: prose, other keys, "Major"
 *                                          -> flags anything that looks risky
 *   few-shot  (3 examples with reasoning)  -> every output in the example's exact format
 *                                          -> acceptable patterns left alone, judgment
 *                                             generalizes to snippets no example showed
 *
 * Run:  npx tsx reviewFormatFewshot.ts          (offline, scripted model)
 *       npx tsx reviewFormatFewshot.ts --live   (real Claude API)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { REVIEW_EXAMPLES, buildReviewPrompt, reviewUserMessage } from "./fewshotPrompts.ts";
import { conforms, findingCount, formatConsistency } from "./scoring.ts";
import { SNIPPETS, reviewModel } from "./scriptedModel.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

async function run(system: string): Promise<Record<string, string>> {
  const client = lab.getClient(reviewModel);
  const outputs: Record<string, string> = {};
  for (const snippet of SNIPPETS) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: reviewUserMessage(snippet) }],
    });
    outputs[snippet.id] = lab.textOf(response).trim();
  }
  return outputs;
}

interface Summary {
  consistency: number;
  falsePositives: string[];
  caught: string[];
}

function summarize(name: string, outputs: Record<string, string>): Summary {
  lab.section(name);
  for (const snippet of SNIPPETS) {
    const text = outputs[snippet.id];
    const [ok, reason] = conforms(text);
    const kind = (snippet.novel ? "novel " : "") + snippet.kind;
    console.log(`  ${snippet.id} ${kind.padEnd(17)} format ${ok ? "OK " : "BAD"} [${reason}]`);
    console.log("     " + text.replace(/\n/g, "\n     ").slice(0, 220));
  }
  const flagged = (id: string) => findingCount(outputs[id]) > 0;
  const result: Summary = {
    consistency: formatConsistency(Object.values(outputs)),
    falsePositives: SNIPPETS.filter((s) => s.kind === "acceptable" && flagged(s.id)).map((s) => s.id),
    caught: SNIPPETS.filter((s) => s.kind === "genuine" && flagged(s.id)).map((s) => s.id),
  };
  console.log(
    `  -> format consistency ${pct(result.consistency)}, false positives ${JSON.stringify(result.falsePositives)}, ` +
      `caught ${JSON.stringify(result.caught)}`,
  );
  return result;
}

lab.banner("D4.2  Few-shot examples: consistent format, fewer false positives");
const fewShotPrompt = buildReviewPrompt(REVIEW_EXAMPLES);
const exampleCount = fewShotPrompt.split("<example ").length - 1;
console.log(`few-shot prompt carries ${exampleCount} examples, each with <reasoning>`);

const zero = summarize("zero-shot: detailed instructions only", await run(buildReviewPrompt()));
const few = summarize("few-shot: same instructions + 3 targeted examples", await run(fewShotPrompt));

const genuine = SNIPPETS.filter((s) => s.kind === "genuine").map((s) => s.id);
const novel = SNIPPETS.filter((s) => s.novel).map((s) => s.id);
lab.check(exampleCount >= 2 && exampleCount <= 4, "2-4 targeted examples, not a long catalogue");
lab.check(fewShotPrompt.split("<reasoning>").length - 1 === REVIEW_EXAMPLES.length, "every example explains why it was (not) flagged");
if (!lab.isLive()) {
  lab.check(zero.consistency < 0.5, "instructions alone: most outputs break the required format");
  lab.check(few.consistency === 1, "few-shot: every output has location, issue, severity, suggested_fix");
  lab.check(zero.falsePositives.length === 2, "zero-shot flags both acceptable patterns");
  lab.check(few.falsePositives.length === 0, "few-shot leaves acceptable patterns alone");
  lab.check(JSON.stringify(few.caught) === JSON.stringify(genuine), "few-shot still catches every genuine issue");
  lab.check(
    few.caught.includes("S4") && !few.falsePositives.includes("S5") && JSON.stringify(novel) === '["S4","S5"]',
    "judgment generalized to novel code (mutable default flagged, intentional narrow except accepted)",
  );
}
