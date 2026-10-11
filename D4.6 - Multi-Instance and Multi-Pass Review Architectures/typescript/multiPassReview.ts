/**
 * D4.6 - Single-pass review of a 7-file PR vs per-file passes + an integration pass (sample Q12).
 *
 *   single pass, all files in one request -> deep on the first files, skims the rest: flags a
 *       construct in one file and APPROVES the identical construct elsewhere, misses an obvious
 *       bug in a later file
 *   per-file passes, identical prompt      -> one file per request, consistent verdicts
 *   integration pass                       -> cross-file data flow (signatures vs call sites,
 *                                             event payload keys) that no single file shows
 *
 * Run:  npx tsx multiPassReview.ts          (offline, scripted reviewer)
 *       npx tsx multiPassReview.ts --live   (real Claude API: 1 + 7 + 1 calls)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  INTEGRATION_PROMPT,
  LOCAL_PROMPT,
  SINGLE_PASS_PROMPT,
  filesMessage,
  loadPr,
  localFindings,
  parseReview,
  scriptedReviewer,
  type Finding,
  type ReviewOutput,
} from "./reviewEngine.ts";

async function call(client: lab.MessagesClient, system: string, content: string): Promise<ReviewOutput> {
  const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system, messages: [{ role: "user", content }] });
  return parseReview(lab.textOf(response));
}

export function reviewSinglePass(client: lab.MessagesClient, files: Record<string, string>): Promise<ReviewOutput> {
  return call(client, SINGLE_PASS_PROMPT, filesMessage(files));
}

export async function reviewPerFile(client: lab.MessagesClient, files: Record<string, string>): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const [name, text] of Object.entries(files)) {
    // same prompt, one file each: same depth for every file
    findings.push(...(await call(client, LOCAL_PROMPT, filesMessage({ [name]: text }))).findings);
  }
  return findings;
}

export async function reviewIntegration(client: lab.MessagesClient, files: Record<string, string>): Promise<Finding[]> {
  return (await call(client, INTEGRATION_PROMPT, filesMessage(files))).findings;
}

export async function runMultiPass(client: lab.MessagesClient, files: Record<string, string>): Promise<[Finding[], Finding[]]> {
  return [await reviewPerFile(client, files), await reviewIntegration(client, files)];
}

export function has(findings: Finding[], pattern: string, file?: string): boolean {
  return findings.some((f) => f.detected_pattern === pattern && (file === undefined || f.file === file));
}

function showFindings(findings: Finding[]): void {
  for (const f of findings) {
    const loc = `${f.file}:${f.line}`;
    console.log(`  ${loc.padEnd(17)} ${f.detected_pattern.padEnd(27)} ${f.severity.padEnd(6)} conf=${f.confidence.toFixed(2)}  ${f.issue.slice(0, 58)}`);
  }
}

async function main(): Promise<void> {
  lab.banner("D4.6  Multi-pass review: per-file passes + integration pass");
  const files = loadPr();
  console.log(`PR: ${Object.keys(files).length} files: ${Object.keys(files).join(", ")}`);

  lab.section("1. Single pass: all 7 files in one request");
  const single = await reviewSinglePass(lab.getClient(scriptedReviewer), files);
  showFindings(single.findings);
  for (const a of single.approved) console.log(`  ${a.file.padEnd(17)} approved ${a.detected_pattern ?? "(file)"}: ${a.comment}`);
  const flaggedPatterns = new Set(single.findings.map((f) => f.detected_pattern));
  const contradictions = single.approved
    .filter((a) => a.detected_pattern !== null && flaggedPatterns.has(a.detected_pattern))
    .map((a) => `${a.detected_pattern}@${a.file}`)
    .sort();
  console.log(`  contradictions (flagged in one file, approved in another): ${JSON.stringify(contradictions)}`);

  lab.section("2. Per-file passes: identical prompt, one file per request");
  const localClient = lab.getClient(scriptedReviewer);
  const local = await reviewPerFile(localClient, files);
  showFindings(local);

  lab.section("3. Integration pass: cross-file data flow only");
  const integration = await reviewIntegration(lab.getClient(scriptedReviewer), files);
  showFindings(integration);

  lab.section("Comparison");
  const multi = [...local, ...integration];
  const rows: [string, string | number | boolean, string | number | boolean][] = [
    ["findings", single.findings.length, multi.length],
    ["contradictory verdicts", contradictions.length, 0],
    ["api.py negative quantity", has(single.findings, "unvalidated-quantity"), has(multi, "unvalidated-quantity")],
    ["swapped adjust_stock args", has(single.findings, "argument-order-mismatch"), has(multi, "argument-order-mismatch")],
    ["event key qty vs quantity", has(single.findings, "event-payload-key-mismatch"), has(multi, "event-payload-key-mismatch")],
  ];
  console.log(`  ${"".padEnd(28)}${"single pass".padStart(12)}${"multi-pass".padStart(12)}`);
  for (const [label, a, b] of rows) console.log(`  ${label.padEnd(28)}${String(a).padStart(12)}${String(b).padStart(12)}`);

  if (!lab.isLive()) {
    // Where the swallowed-exception construct really appears (ground truth from the detector).
    const constructFiles = Object.entries(files)
      .filter(([name, text]) => localFindings(name, text).some((f) => f.detected_pattern === "swallowed-exception"))
      .map(([name]) => name);
    const localHits = local.filter((f) => f.detected_pattern === "swallowed-exception");
    const perFileCalls = (localClient as lab.ScriptedClient).calls;
    lab.check(
      contradictions.includes("swallowed-exception@events.py") && has(single.findings, "swallowed-exception", "repository.py"),
      "single pass: the same construct is flagged in repository.py and approved in events.py",
    );
    lab.check(!has(single.findings, "unvalidated-quantity"), "single pass: the obvious negative-quantity bug in a late file is missed");
    lab.check(
      perFileCalls.length === Object.keys(files).length &&
        new Set(perFileCalls.map((c) => lab.systemText(c))).size === 1 &&
        perFileCalls.every((c) => String(c.messages[0].content).split("<file ").length - 1 === 1),
      "per-file passes: one file per request, all with the identical prompt",
    );
    lab.check(
      JSON.stringify(localHits.map((f) => f.file)) === JSON.stringify(constructFiles) &&
        new Set(localHits.map((f) => `${f.severity}/${f.confidence}`)).size === 1,
      "per-file passes: the construct gets the same verdict and severity in all 3 files",
    );
    lab.check(has(local, "unvalidated-quantity", "api.py"), "per-file passes: the api.py bug gets full attention and is found");
    lab.check(
      has(integration, "argument-order-mismatch", "service.py") && has(integration, "event-payload-key-mismatch", "reports.py"),
      "integration pass: both cross-file bugs found",
    );
    lab.check(
      !has(local, "argument-order-mismatch") && !has(local, "event-payload-key-mismatch"),
      "...which no per-file pass could see: each needs two files at once",
    );
  }
}

// confidenceRouting.ts imports runMultiPass; only run the demo when executed directly.
if (lab.isMain(import.meta.url)) await main();
