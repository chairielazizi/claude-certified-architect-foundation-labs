/**
 * D4.6 - Self-review in the same session vs an independent reviewer instance.
 *
 *   generator turn          -> code + its own design reasoning (contains a subtle bug)
 *   self-review, same chat  -> the reasoning is still in context: "consistent with my design"
 *   "think very carefully"  -> same context, same blind spot
 *   independent reviewer    -> fresh messages: ONLY the spec and the code -> catches the bug
 *
 * Run:  npx tsx generatorReview.ts          (offline, scripted model)
 *       npx tsx generatorReview.ts --live   (real Claude API)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { GENERATOR_SYSTEM, REVIEWER_SYSTEM, SELF_REVIEW, SELF_REVIEW_HARDER, TASK, scriptedModel } from "./generatorModel.ts";

interface ReviewFinding {
  issue: string;
  severity: string;
  confidence: number;
}

function findingsOf(response: Anthropic.Message): ReviewFinding[] {
  const text = lab.textOf(response);
  return (JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { findings: ReviewFinding[] }).findings;
}

lab.banner("D4.6  Self-review vs independent review instance");

lab.section("1. Generator writes the code");
const generator = lab.getClient(scriptedModel);
const genRequest: lab.CreateParams = { model: lab.MODEL, max_tokens: 16000, system: GENERATOR_SYSTEM, messages: [{ role: "user", content: TASK }] };
const generated = await generator.messages.create(genRequest);
const generatedText = lab.textOf(generated);
const codeBlock = generatedText.match(/```python\n([\s\S]*?)```/);
const code = codeBlock ? codeBlock[1] : generatedText;
console.log("  " + generatedText.replace(/\n/g, "\n  "));
const history: Anthropic.MessageParam[] = [...genRequest.messages, { role: "assistant", content: generated.content }];

lab.section("2. Self-review in the same conversation");
const selfReviews: Record<string, [lab.CreateParams, ReviewFinding[]]> = {};
for (const [label, ask] of [["review", SELF_REVIEW], ["think very carefully", SELF_REVIEW_HARDER]] as const) {
  const request: lab.CreateParams = { ...genRequest, messages: [...history, { role: "user", content: ask }] };
  selfReviews[label] = [request, findingsOf(await generator.messages.create(request))];
  const found = selfReviews[label][1];
  console.log(`  self-review (${label}): ${found.length ? JSON.stringify(found) : "no issues found"}`);
}

lab.section("3. Independent reviewer: a new instance with only the spec and the code");
const reviewer = lab.getClient(scriptedModel); // separate client/session; nothing shared
const reviewRequest: lab.CreateParams = {
  model: lab.MODEL,
  max_tokens: 16000,
  system: REVIEWER_SYSTEM,
  messages: [{ role: "user", content: `<spec>\n${TASK}\n</spec>\n<code>\n${code.trim()}\n</code>` }],
};
const independent = findingsOf(await reviewer.messages.create(reviewRequest));
for (const f of independent) console.log(`  [${f.severity}, conf ${f.confidence}] ${f.issue}`);

const selfRequest = selfReviews.review[0];
const reasoning = generatedText.split("```")[0].trim(); // the generator's explanation, outside the code block
const reviewContent = String(reviewRequest.messages[0].content);
lab.check(
  selfRequest.messages[1].role === "assistant" && (selfRequest.messages[1].content as unknown) === generated.content,
  "the self-review request carries the generator's own reasoning",
);
lab.check(
  reviewRequest.messages.length === 1 &&
    reviewRequest.messages[0].role === "user" &&
    !reviewContent.includes(reasoning.slice(0, 80)) &&
    reviewRequest.system !== GENERATOR_SYSTEM,
  "the independent request has no generator history: one user message with spec + code",
);
if (!lab.isLive()) {
  lab.check(Object.values(selfReviews).every(([, f]) => f.length === 0), "self-review missed the bug, even when told to question every assumption");
  lab.check(independent.some((f) => f.issue.includes("Off-by-one")), "the independent reviewer caught the off-by-one");
  // Offline only, on our own scripted code (never model output): evaluate the start offset for page 1.
  const expr = (code.match(/start = (.+)/) ?? ["", "0"])[1];
  const start = new Function("page", "page_size", `return ${expr};`)(1, 3) as number;
  const actual = Array.from({ length: 10 }, (_, i) => i).slice(start, start + 3);
  console.log(`  proof: paginate(range(10), page=1, page_size=3) -> ${JSON.stringify(actual)} (spec says [0, 1, 2])`);
  lab.check(JSON.stringify(actual) !== "[0,1,2]", "the bug is real: page 1 skips the first three items");
}
