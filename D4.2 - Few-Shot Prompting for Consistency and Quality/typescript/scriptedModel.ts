/**
 * Offline stand-ins for Claude in D4.2. Behaviour is driven by the examples in the prompt.
 *
 * reviewModel:
 *  - zero-shot -> judgment is "anything that looks risky", and the output format drifts from
 *                 snippet to snippet (prose, other key names, other severity words): the failure
 *                 mode the exam describes for instructions-only prompts
 *  - few-shot  -> copies the keys and severity words from the first example's output; if an
 *                 example shows an acceptable-looking pattern being NOT flagged, it applies that
 *                 judgment ("is the failure still visible?") instead of flagging on sight
 *
 * extractionModel: a literal-minded reader unless the examples demonstrate otherwise.
 *  - an example with a References list                   -> reads bibliography / notes entries
 *  - an example with methodology but no Methods heading  -> finds methods in the narrative
 *  - an example with approximate measurements / "Name's YEAR" citation -> reads informal ones
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import { loadJson, type Snippet } from "./fewshotPrompts.ts";

export const SNIPPETS: Snippet[] = loadJson<{ snippets: Snippet[] }>("review_snippets.json").snippets;

// ---------------------------------------------------------------------------
// Review model
// ---------------------------------------------------------------------------

type Finding = { location: string; issue: string; severity: string; suggested_fix: string };

const SEVERITY_WORDS: Record<string, string> = { low: "Minor", medium: "Moderate", high: "Major", critical: "Blocker" };

function exampleOutputs(system: string): unknown[] {
  return [...system.matchAll(/<output>([\s\S]*?)<\/output>/g)].map((m) => JSON.parse(m[1]) as unknown);
}

/** Instructions alone: the substance is there, the shape is not stable. */
function zeroShotText(index: number, f: Finding): string {
  switch (index % 5) {
    case 0:
      return JSON.stringify([{ ...f, severity: SEVERITY_WORDS[f.severity] }]);
    case 1:
      return `I found one problem in ${f.location}: ${f.issue} I would rate this ${f.severity} severity. To fix it: ${f.suggested_fix}`;
    case 2: {
      const cut = f.location.lastIndexOf(":");
      return JSON.stringify({ file: f.location.slice(0, cut), line: Number(f.location.slice(cut + 1)), problem: f.issue, level: f.severity });
    }
    case 3:
      return `- **${f.location}** (${f.severity}): ${f.issue}\n  - Fix: ${f.suggested_fix}`;
    default:
      return JSON.stringify([f]);
  }
}

export function reviewModel(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  const file = (lab.lastUserText(params).match(/<code file="([^"]+)">/) ?? ["", ""])[1];
  const index = SNIPPETS.findIndex((s) => s.file === file);
  const snippet = SNIPPETS[index];

  const outputs = exampleOutputs(system);
  const fewShot = outputs.length >= 2;
  const learnedAcceptable = outputs.some((o) => Array.isArray(o) && o.length === 0); // "looks risky, NOT an issue"

  let finding: Finding | null;
  if (snippet.kind === "genuine" && snippet.truth) {
    finding = { ...snippet.truth };
  } else if (fewShot && learnedAcceptable) {
    finding = null; // same judgment as the acceptable example: nothing is swallowed
  } else {
    finding = {
      location: `${snippet.file}:${snippet.suspicious_line}`,
      issue: `Risky pattern: ${snippet.looks_suspicious_because}.`,
      severity: "medium",
      suggested_fix: "Narrow or remove the exception handler.",
    };
  }

  if (!fewShot) return lab.message([lab.text(finding ? zeroShotText(index, finding) : "[]")]);

  // Few-shot: mirror the example format key-for-key.
  const template = outputs.find((o) => Array.isArray(o) && o.length > 0) as Record<string, unknown>[];
  const keys = Object.keys(template[0]) as (keyof Finding)[];
  const f = finding;
  const shaped = f ? [Object.fromEntries(keys.map((k) => [k, f[k]]))] : [];
  return lab.message([lab.text(JSON.stringify(shaped))]);
}

// ---------------------------------------------------------------------------
// Extraction model
// ---------------------------------------------------------------------------

const STUDY_VERBS = /\b(ran|surveyed|interviewed|measured|weighed|sampled|recruited|mixed|steeped|compared|matched)\b/;
const INFORMAL: Record<string, [number, string | null]> = {
  "a couple of": [2, null],
  "about half a": [0.5, null],
  "half a": [0.5, null],
  "roughly a dozen": [12, null],
  "a dozen": [12, null],
  "a handful of": [1, "handful"],
  "a pinch of": [1, "pinch"],
};
const UNITS: Record<string, string> = { cup: "cup", cups: "cup", gram: "g", grams: "g", teaspoon: "tsp", teaspoons: "tsp" };

interface Skills {
  bibliography: boolean;
  embeddedMethods: boolean;
  informal: boolean;
  narrativeCitations: boolean;
}

interface ExampleOutput {
  methodology?: string | null;
  measurements?: { approximate?: boolean }[];
}

/** What the examples in the prompt demonstrate. */
function skillsFrom(system: string): Skills {
  const docs = [...system.matchAll(/<document>\n([\s\S]*?)\n<\/document>/g)].map((m) => m[1]);
  const outs = [...system.matchAll(/<output>([\s\S]*?)<\/output>/g)].map((m) => JSON.parse(m[1]) as ExampleOutput);
  return {
    bibliography: docs.some((d) => d.includes("\nReferences\n")),
    embeddedMethods: docs.some((d, i) => Boolean(outs[i]?.methodology) && !d.includes("Methods:")),
    informal: outs.some((o) => (o.measurements ?? []).some((m) => m.approximate === true)),
    narrativeCitations: docs.some((d) => /[A-Z][a-z]+'s \d{4}/.test(d)),
  };
}

interface Measured {
  quantity: number | null;
  unit: string;
  approximate: boolean;
  original_text: string;
}

function extract(text: string, skills: Skills): Record<string, unknown> {
  const title = (text.match(/^Title: (.+)$/m) ?? ["", ""])[1];
  const split = /\n(?:References|Notes)\n/.exec(text);
  const body = split ? text.slice(0, split.index) : text;
  const bibliography = split ? text.slice(split.index + split[0].length) : "";

  // methodology: the literal reader only trusts a "Methods:" heading
  const heading = body.match(/^Methods: (.+)$/m);
  let methodology: string | null = heading ? heading[1] : null;
  if (methodology === null && skills.embeddedMethods) {
    const sentences = body.slice(body.indexOf("\n") + 1).split(/(?<=[.!?])\s+/);
    const hit = sentences.find((s) => STUDY_VERBS.test(s));
    methodology = hit ? hit.trim().replace(/^\w+: /, "") : null;
  }

  const citations = [...body.matchAll(/\(([A-Z][A-Za-z]+(?: et al\.)?), (\d{4})\)/g)].map((m) => `${m[1]} (${m[2]})`);
  if (skills.narrativeCitations) {
    citations.push(...[...body.matchAll(/\b([A-Z][a-z]+)'s (\d{4})\b/g)].map((m) => `${m[1]} (${m[2]})`));
  }
  if (skills.bibliography && bibliography) {
    citations.push(...[...bibliography.matchAll(/^(?:\d+\.|\^\d+)\s+(.+)$/gm)].map((m) => m[1]));
  }

  const found: [number, Measured][] = [];
  for (const m of body.matchAll(/(\d+(?:\.\d+)?)\s*(mL|g|kg|L)\b(?: of ([a-z]+(?: [a-z]+)?))?/g)) {
    found.push([m.index ?? 0, { quantity: Number(m[1]), unit: m[2], approximate: false, original_text: m[0] }]);
  }
  if (skills.informal) {
    const phrases = Object.keys(INFORMAL).sort((a, b) => b.length - a.length).join("|");
    const pattern = new RegExp(`(${phrases})\\s*(cups?|grams?|teaspoons?)?(?: of)? ([a-z]+)`, "g");
    for (const m of body.matchAll(pattern)) {
      const [qty, phraseUnit] = INFORMAL[m[1]];
      const unit = UNITS[m[2] ?? ""] ?? phraseUnit ?? "unit";
      found.push([m.index ?? 0, { quantity: qty, unit, approximate: true, original_text: m[0] }]);
    }
  }
  const measurements = found.sort((a, b) => a[0] - b[0]).map(([, m]) => m);

  return { title, methodology, citations, measurements };
}

export function extractionModel(params: lab.CreateParams): Anthropic.Message {
  const system = lab.systemText(params);
  const document = (lab.lastUserText(params).match(/<document>\n([\s\S]*)\n<\/document>/) ?? ["", ""])[1];
  return lab.message([lab.text(JSON.stringify(extract(document, skillsFrom(system))))]);
}
