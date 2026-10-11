/**
 * D4.2 - Few-shot examples fix empty/null extraction from documents with varied structures.
 *
 *   zero-shot           -> methodology null when there is no "Methods" heading, citations empty
 *                          when they live in a bibliography, informal amounts dropped
 *   1 generic example   -> format fixed, the same fields still empty (examples must TARGET the
 *                          hard cases)
 *   2 targeted examples -> bibliography, embedded methods, "a couple of cups" all extracted,
 *                          including a structure no example showed (footnote-style Notes)
 *
 * Run:  npx tsx extractionFewshot.ts          (offline, scripted model)
 *       npx tsx extractionFewshot.ts --live   (real Claude API)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  GENERIC_EXAMPLE,
  TARGETED_EXAMPLES,
  buildExtractionPrompt,
  extractionUserMessage,
  loadJson,
  type ResearchDoc,
} from "./fewshotPrompts.ts";
import { missingRequired, parseExtraction, type PaperExtraction } from "./scoring.ts";
import { extractionModel } from "./scriptedModel.ts";

const DOCS: ResearchDoc[] = loadJson<{ documents: ResearchDoc[] }>("research_docs.json").documents;

interface RunResult {
  extractions: Record<string, PaperExtraction | null>;
  missing: Record<string, string[]>;
}

async function run(name: string, system: string): Promise<RunResult> {
  lab.section(name);
  const client = lab.getClient(extractionModel);
  const out: RunResult = { extractions: {}, missing: {} };
  for (const doc of DOCS) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: extractionUserMessage(doc) }],
    });
    const ex = parseExtraction(lab.textOf(response));
    out.extractions[doc.id] = ex;
    out.missing[doc.id] = missingRequired(ex, doc.expected);
    const exp = doc.expected;
    const found =
      ex === null
        ? "unparseable output"
        : `methodology=${ex.methodology ? "yes" : "NULL"}  citations=${ex.citations.length}/${exp.citations}  ` +
          `measurements=${ex.measurements.length}/${exp.measurements}`;
    console.log(`  ${doc.id} [${doc.structure.slice(0, 50)}]\n     ${found}  missing=${JSON.stringify(out.missing[doc.id])}`);
  }
  console.log(`  -> required fields empty although present in the source: ${total(out.missing)}`);
  return out;
}

function total(missing: Record<string, string[]>): number {
  return Object.values(missing).reduce((n, m) => n + m.length, 0);
}

lab.banner("D4.2  Few-shot examples for varied document structures");
const zero = await run("zero-shot: instructions only", buildExtractionPrompt());
const generic = await run("few-shot: 1 generic example", buildExtractionPrompt([GENERIC_EXAMPLE]));
const targeted = await run("few-shot: 2 targeted examples with reasoning", buildExtractionPrompt(TARGETED_EXAMPLES));

lab.section("Informal measurements (P3) with targeted examples");
const p3 = targeted.extractions.P3?.measurements ?? [];
for (const m of p3) {
  console.log(`  ${JSON.stringify(m.original_text).padEnd(32)} -> quantity=${m.quantity} unit=${m.unit} approximate=${m.approximate}`);
}

if (!lab.isLive()) {
  const p2 = targeted.extractions.P2;
  const p4 = targeted.extractions.P4;
  lab.check(total(zero.missing) > 0, "zero-shot leaves required fields empty on non-standard documents");
  lab.check(total(generic.missing) === total(zero.missing), "a generic example fixes the format, not the hard cases");
  lab.check(total(targeted.missing) === 0, "targeted examples: no required field left empty");
  lab.check(
    p2 !== null && p2.citations.length === 2 && p2.methodology !== null,
    "P2: citations read from the bibliography, methodology found without a Methods heading",
  );
  lab.check(
    p3.some((m) => m.original_text.startsWith("a couple of cups") && m.quantity === 2 && m.unit === "cup" && m.approximate),
    "'a couple of cups' -> quantity 2, unit cup, approximate (kept, not dropped or invented)",
  );
  lab.check(
    p4 !== null && p4.citations.length === 1 && targeted.missing.P4.length === 0,
    "P4 (footnote Notes, 'Approach' label - in no example) also extracted: the model generalized",
  );
}
