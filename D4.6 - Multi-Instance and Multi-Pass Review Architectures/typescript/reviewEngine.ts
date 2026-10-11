/**
 * Review prompts, finding schema and the offline reviewer for D4.6's multi-pass demos.
 *
 * The PR under review (fixtures/pr/inventory, 7 files) contains:
 *  - the same swallowed-exception construct in repository.py, events.py and audit.py
 *  - an unvalidated quantity in api.py (negative qty frees reserved stock)
 *  - two CROSS-FILE bugs no single file shows: service.py calls adjust_stock(qty, sku) against
 *    def adjust_stock(self, sku, delta); reports.py reads event["quantity"] while service.py
 *    publishes {"qty": ...}
 *
 * The offline reviewer applies the same detectors whatever the mode, but what it can see and how
 * much attention each file gets depends on the request:
 *  - one <file> per request (local pass) -> every detector on that file, full depth
 *  - INTEGRATION in the system prompt    -> only cross-file detectors, across all files
 *  - many files, one request (single)    -> full depth for the first files only; later files get a
 *    skim that APPROVES constructs it flagged earlier: a deterministic stand-in for the attention
 *    dilution described in sample question 12
 *  - VERIFY in the system prompt         -> re-checks one finding against the code
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";
import * as lab from "../../shared/typescript/labkit.ts";

const PR_DIR = new URL("../fixtures/pr/inventory/", import.meta.url);
export const PR_ORDER = ["models.py", "repository.py", "service.py", "events.py", "reports.py", "api.py", "audit.py"];
const SINGLE_PASS_DEEP_FILES = 2;

const FORMAT =
  'Respond with JSON only: {"findings": [{"file", "line", "detected_pattern" (kebab-case), "issue", ' +
  '"severity" (low|medium|high), "confidence" (0-1: how sure you are it is a real problem)}], ' +
  '"approved": [{"file", "detected_pattern", "comment"}]}.';
export const LOCAL_PROMPT =
  "You review ONE file from a pull request for local issues: bugs, error handling, input validation, " +
  "resource use. Judge each construct on its merits; the same construct gets the same verdict in every file. " +
  FORMAT;
export const INTEGRATION_PROMPT =
  "INTEGRATION PASS. Local issues inside each file were already reviewed in separate passes. Look only at " +
  "cross-file data flow: do call sites match the signatures they call (argument order, units), and do event " +
  "payloads match the keys their consumers read? " +
  FORMAT;
export const SINGLE_PASS_PROMPT =
  "Review this pull request. Report every issue; list constructs you checked and consider fine under approved. " + FORMAT;
export const VERIFY_PROMPT =
  "VERIFY one finding from an automated review that you did not write. Using only the code provided, decide " +
  'whether it is a real problem. Respond with JSON only: {"verdict": "confirmed|rejected|uncertain", ' +
  '"confidence": 0-1, "evidence": "..."}.';

export const Finding = z.strictObject({
  file: z.string(),
  line: z.number().int(),
  detected_pattern: z.string(),
  issue: z.string(),
  severity: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof Finding>;

const Approval = z.strictObject({ file: z.string(), detected_pattern: z.string().nullable(), comment: z.string() });
export const ReviewOutput = z.strictObject({ findings: z.array(Finding), approved: z.array(Approval) });
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export interface Verdict {
  verdict: "confirmed" | "rejected" | "uncertain";
  confidence: number;
  evidence: string;
}

export function loadPr(): Record<string, string> {
  return Object.fromEntries(PR_ORDER.map((name) => [name, readFileSync(new URL(name, PR_DIR), "utf-8")]));
}

export function filesMessage(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([name, text]) => `<file path="inventory/${name}">\n${text}</file>`)
    .join("\n");
}

function parseFiles(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of message.matchAll(/<file path="inventory\/([^"]+)">\n([\s\S]*?)<\/file>/g)) out[m[1]] = m[2];
  return out;
}

export function parseReview(text: string): ReviewOutput {
  return ReviewOutput.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
}

// ---------------------------------------------------------------------------
// Detectors (what a careful reviewer notices)
// ---------------------------------------------------------------------------

export function localFindings(name: string, text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    const nxt = lines[i + 1] ?? "";
    const after = lines[i + 2] ?? "";
    if (line.trim() === "except Exception:" && /^\s*log(ger)?\.\w+\(/.test(nxt) && !after.includes("raise")) {
      out.push({ file: name, line: n, detected_pattern: "swallowed-exception", severity: "high", confidence: 0.9,
        issue: "Exception is logged and swallowed; the caller believes the operation succeeded." });
    }
    const m = line.match(/^\s*(\w+) = int\(body\["(\w+)"\]\)/);
    if (m && !new RegExp(`if ${m[1]} <= 0|${m[1]} < 1`).test(nxt)) {
      out.push({ file: name, line: n, detected_pattern: "unvalidated-quantity", severity: "high", confidence: 0.85,
        issue: `${m[1]} is not checked for > 0; a negative quantity reverses the operation (reserve(-5) frees stock).` });
    }
    const list = line.match(/^(\w+) = \[\]$/);
    if (list && text.includes(`${list[1]}.append(`) && !text.includes(`${list[1]}.clear()`)) {
      out.push({ file: name, line: n, detected_pattern: "unbounded-module-list", severity: "medium", confidence: 0.6,
        issue: `Module-level list ${list[1]} only grows; in a long-running process it is never reset.` });
    }
    if (name === "models.py" && /^\s+on_hand: int/.test(line)) {
      out.push({ file: name, line: n, detected_pattern: "unenforced-int-annotation", severity: "low", confidence: 0.4,
        issue: "Quantities are annotated int but nothing enforces it; float quantities could slip in." });
    }
  });
  const firstInt = lines.findIndex((l) => l.includes("int(body["));
  if (firstInt >= 0) {
    out.push({ file: name, line: firstInt + 1, detected_pattern: "int-parse-valueerror", severity: "medium", confidence: 0.55,
      issue: "int() raises ValueError on non-numeric input; unless something maps it, the client gets a 500." });
  }
  return out;
}

export function integrationFindings(files: Record<string, string>): Finding[] {
  const out: Finding[] = [];
  // 1. call sites vs signatures (positional argument order)
  const signatures: Record<string, [string, string]> = {};
  for (const text of Object.values(files)) {
    for (const m of text.matchAll(/def (\w+)\(self, (\w+)[^,)]*, (\w+)/g)) signatures[m[1]] = [m[2], m[3]];
  }
  for (const [name, text] of Object.entries(files)) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/\.(\w+)\(([\w.]+), ([\w.]+)\)/g)) {
        const sig = signatures[m[1]];
        if (!sig) continue;
        const [first, second] = sig;
        const lastPart = (s: string) => s.split(".").slice(-1)[0];
        if (lastPart(m[3]) === first && lastPart(m[2]) !== first) {
          out.push({ file: name, line: i + 1, detected_pattern: "argument-order-mismatch", severity: "high", confidence: 0.9,
            issue: `${m[1]}(${m[2]}, ${m[3]}) but the signature is ${m[1]}(${first}, ${second}): sku and quantity are swapped.` });
        }
      }
    });
  }
  // 2. event payload keys published vs keys consumers read
  const published: Record<string, Set<string>> = {};
  for (const text of Object.values(files)) {
    for (const m of text.matchAll(/publish\("([\w.]+)", \{(.*?)\}\)/g)) {
      published[m[1]] = new Set([...m[2].matchAll(/"(\w+)":/g)].map((k) => k[1]));
    }
  }
  for (const [name, text] of Object.entries(files)) {
    for (const [, topic, handler] of text.matchAll(/subscribe\("([\w.]+)", (\w+)\)/g)) {
      const body = text.match(new RegExp(`def ${handler}\\(\\w+\\):\\n([\\s\\S]*?)(?:\\n\\n|$)`));
      for (const [, key] of (body ? body[1] : "").matchAll(/event\["(\w+)"\]/g)) {
        if (published[topic] && !published[topic].has(key)) {
          const line = text.split("\n").findIndex((ln) => ln.includes(`event["${key}"]`)) + 1;
          out.push({ file: name, line, detected_pattern: "event-payload-key-mismatch", severity: "high", confidence: 0.85,
            issue: `${handler} reads event['${key}'] but '${topic}' is published with keys ${JSON.stringify([...published[topic]].sort())}; ` +
              "the KeyError is then swallowed by publish()." });
        }
      }
    }
  }
  return out;
}

export function verify(finding: Finding, files: Record<string, string>): Verdict {
  const everything = Object.values(files).join("\n");
  const pattern = finding.detected_pattern;
  if (pattern === "unbounded-module-list") {
    const v = (finding.issue.match(/list (\w+)/) ?? ["", ""])[1];
    const resets = new RegExp(`${v}\\.clear\\(\\)|^[ \\t]+${v} = \\[\\]`, "m"); // indented = a reset
    if (!resets.test(everything)) {
      return { verdict: "confirmed", confidence: 0.85, evidence: `${v} is appended to in on_received and never cleared or reassigned in the PR.` };
    }
  }
  if (pattern === "unenforced-int-annotation" && everything.includes("int(body[")) {
    return { verdict: "rejected", confidence: 0.15, evidence: "Every quantity enters through int(body[...]) in api.py, so floats cannot reach StockItem." };
  }
  if (pattern === "int-parse-valueerror" && !everything.includes("except ValueError")) {
    return { verdict: "uncertain", confidence: 0.5, evidence: "No ValueError handling in the PR, but the web framework's error mapping is not part of the diff." };
  }
  return { verdict: "confirmed", confidence: finding.confidence, evidence: "re-checked against the code" };
}

// ---------------------------------------------------------------------------
// Offline reviewer
// ---------------------------------------------------------------------------

export function scriptedReviewer(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  const user = lab.lastUserText(params);
  const files = parseFiles(user);

  if (system.startsWith("VERIFY")) {
    const finding = Finding.parse(JSON.parse((user.match(/<finding>\n([\s\S]*?)\n<\/finding>/) ?? ["", "{}"])[1]));
    return lab.message([lab.text(JSON.stringify(verify(finding, files)))]);
  }
  if (system.startsWith("INTEGRATION")) {
    return lab.message([lab.text(JSON.stringify({ findings: integrationFindings(files), approved: [] }))]);
  }

  let findings: Finding[] = [];
  const approved: { file: string; detected_pattern: string | null; comment: string }[] = [];
  const entries = Object.entries(files);
  if (entries.length === 1) {
    // focused local pass: full attention on one file
    findings = localFindings(entries[0][0], entries[0][1]);
  } else {
    // everything at once: attention runs out after the first files
    const seen = new Set<string>();
    entries.forEach(([name, text], index) => {
      const local = localFindings(name, text);
      if (index < SINGLE_PASS_DEEP_FILES) {
        findings.push(...local);
        for (const f of local) seen.add(f.detected_pattern);
        return;
      }
      const skimmed = local.filter((f) => seen.has(f.detected_pattern));
      for (const f of skimmed) {
        // recognizes the construct but waves it through this time
        approved.push({ file: name, detected_pattern: f.detected_pattern, comment: "Error handling logs the failure; looks fine." });
      }
      if (!skimmed.length) approved.push({ file: name, detected_pattern: null, comment: "Looks good." });
    });
  }
  return lab.message([lab.text(JSON.stringify({ findings, approved }))]);
}
