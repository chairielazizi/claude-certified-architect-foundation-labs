/**
 * D4.6 - Self-reported confidence per finding -> calibrated routing + a verification pass.
 *
 *   confidence >= 0.8      -> auto-post as a PR comment
 *   confidence <  0.8      -> verification pass: an independent instance re-checks ONLY that
 *                             finding against the code (fresh context, no reviewer reasoning)
 *     confirmed (>= 0.8)   -> auto-post
 *     rejected             -> drop (logged, never shown to the developer)
 *     uncertain            -> human triage queue
 *
 * Run:  npx tsx confidenceRouting.ts          (offline, scripted reviewer)
 *       npx tsx confidenceRouting.ts --live   (real Claude API)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { runMultiPass } from "./multiPassReview.ts";
import { VERIFY_PROMPT, filesMessage, loadPr, scriptedReviewer, type Finding, type Verdict } from "./reviewEngine.ts";

const AUTO_POST_THRESHOLD = 0.8;

async function verifyFinding(client: lab.MessagesClient, finding: Finding, files: Record<string, string>): Promise<Verdict> {
  const content = `<finding>\n${JSON.stringify(finding)}\n</finding>\n${filesMessage(files)}`;
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 4000,
    system: VERIFY_PROMPT,
    messages: [{ role: "user", content }],
  });
  const text = lab.textOf(response);
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Verdict;
}

lab.banner("D4.6  Confidence-based routing with a verification pass");
const files = loadPr();
const [local, integration] = await runMultiPass(lab.getClient(scriptedReviewer), files);
const findings = [...local, ...integration];

lab.section("1. Route by self-reported confidence");
const autoPost = findings.filter((f) => f.confidence >= AUTO_POST_THRESHOLD);
const toVerify = findings.filter((f) => f.confidence < AUTO_POST_THRESHOLD);
console.log(`  ${findings.length} findings: ${autoPost.length} at >= ${AUTO_POST_THRESHOLD} -> auto-post, ${toVerify.length} -> verification pass`);

lab.section("2. Verification pass on the low-confidence findings");
const verifier = lab.getClient(scriptedReviewer); // separate instance: no reviewer history
const dropped: Finding[] = [];
const human: [Finding, Verdict][] = [];
let verified = 0;
for (const f of toVerify) {
  const result = await verifyFinding(verifier, f, files);
  verified += 1;
  console.log(
    `  ${f.file}:${f.line} ${f.detected_pattern} (conf ${f.confidence.toFixed(2)}) -> ${result.verdict} ` +
      `(${result.confidence.toFixed(2)}): ${result.evidence}`,
  );
  if (result.verdict === "confirmed" && result.confidence >= AUTO_POST_THRESHOLD) autoPost.push({ ...f, confidence: result.confidence });
  else if (result.verdict === "rejected") dropped.push(f);
  else human.push([f, result]);
}

lab.section("3. Outcome");
console.log(`  auto-posted : ${autoPost.length}  ${JSON.stringify([...new Set(autoPost.map((f) => f.detected_pattern))].sort())}`);
console.log(`  human triage: ${human.length}  ${JSON.stringify(human.map(([f]) => f.detected_pattern))}`);
console.log(`  dropped     : ${dropped.length}  ${JSON.stringify(dropped.map((f) => f.detected_pattern))}`);

lab.check(autoPost.every((f) => f.confidence >= AUTO_POST_THRESHOLD), "nothing below the threshold is auto-posted");
lab.check(verified === toVerify.length, "every low-confidence finding went through a verification pass");
if (!lab.isLive()) {
  const calls = (verifier as lab.ScriptedClient).calls;
  lab.check(
    calls.every((c) => c.messages.length === 1 && lab.systemText(c) === VERIFY_PROMPT),
    "each verification is a fresh, single-message request (no reviewer reasoning carried over)",
  );
  lab.check(autoPost.some((f) => f.detected_pattern === "unbounded-module-list"), "a 0.60 finding was confirmed by verification and posted");
  lab.check(
    JSON.stringify(dropped.map((f) => f.detected_pattern)) === '["unenforced-int-annotation"]',
    "a 0.40 finding was rejected and never reached the developer",
  );
  lab.check(
    JSON.stringify(human.map(([f]) => f.detected_pattern)) === '["int-parse-valueerror"]',
    "only the genuinely undecidable one goes to a human",
  );
}
