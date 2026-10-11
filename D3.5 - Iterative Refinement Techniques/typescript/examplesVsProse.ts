/**
 * D3.5 - Concrete input/output examples beat a prose description of a transformation.
 *
 * "Uppercase letters, a hyphen, then the number, with any variant at the end" leaves open whether
 * numbers are zero-padded and how the variant is separated, so different items get different
 * readings. Two or three examples answer those questions at once.
 *
 * Run:  npx tsx examplesVsProse.ts          (offline: a scripted model shows the effect)
 *       npx tsx examplesVsProse.ts --live   (real Claude, structured JSON output)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

const PROSE =
  "Normalize each product code to our standard format: uppercase category letters, a hyphen, then the " +
  "item number, with any variant at the end.";
const EXAMPLES: Array<[string, string]> = [
  ["ab 12", "AB-0012"],
  ["kt_9_red", "KT-0009-RED"],
  ["Xy-0457", "XY-0457"],
];
const CODES = ["  pd 101  ", "zz-7 blue", "LM/88/xl", "cd 5", "Rt-3030", "gh_42_Navy"];
const EXPECTED = ["PD-0101", "ZZ-0007-BLUE", "LM-0088-XL", "CD-0005", "RT-3030", "GH-0042-NAVY"];
const CANONICAL = /^[A-Z]{2}-\d{4}(?:-[A-Z]+)?$/;
const OUTPUT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: { codes: { type: "array", items: { type: "string" } } },
    required: ["codes"],
    additionalProperties: false,
  },
};

function buildPrompt(codes: string[], examples?: Array<[string, string]>): string {
  const lines = [PROSE];
  if (examples) lines.push("", "Examples:", ...examples.map(([src, dst]) => `${JSON.stringify(src)} -> ${JSON.stringify(dst)}`));
  lines.push("", "Return the normalized codes in the same order.", `Codes: ${JSON.stringify(codes)}`);
  return lines.join("\n");
}

async function normalize(client: lab.MessagesClient, prompt: string): Promise<string[]> {
  // output_config.format = structured output: the text block is valid JSON matching the schema.
  // Cast because the param shape is newer than some SDK type definitions.
  const params = {
    model: lab.MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: OUTPUT_FORMAT },
  } as unknown as lab.CreateParams;
  const response = await client.messages.create(params);
  return (JSON.parse(lab.textOf(response)) as { codes: string[] }).codes;
}

/** "ZZ-7 blue" -> "AA-9 aaaa": makes formatting differences visible at a glance. */
const shape = (code: string) => code.replace(/\d/g, "9").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a");

// ---------------------------------------------------------------------------
// Offline stand-in for Claude
// ---------------------------------------------------------------------------

const PARTS = /^\s*([A-Za-z]{2})[\s_/-]*(\d+)(?:[\s_/-]+([A-Za-z]+))?\s*$/;
const pad = (num: string, width: number) => String(Number(num)).padStart(width, "0");

// Three readings the prose genuinely allows; nothing in the sentence rules any of them out.
const READINGS: Array<(cat: string, num: string, variant?: string) => string> = [
  (cat, num, v) => `${cat.toUpperCase()}-${num}${v ? ` ${v}` : ""}`, // no padding, variant after a space
  (cat, num, v) => `${cat.toUpperCase()}-${pad(num, 4)}${v ? `-${v.toUpperCase()}` : ""}`, // padded, hyphenated
  (cat, num, v) => `${cat.toUpperCase()}${num}${v ? `-${v.toUpperCase()}` : ""}`, // the hyphen read as the variant's
];

function split(code: string): [string, string, string | undefined] {
  const m = PARTS.exec(code);
  if (!m) throw new Error(`unparseable code ${code}`);
  return [m[1], m[2], m[3]];
}

function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const prompt = lab.lastUserText(params);
  const codes = JSON.parse(prompt.split("Codes: ").pop() ?? "[]") as string[];
  const examples = [...prompt.matchAll(/^(".*") -> (".*")$/gm)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])] as [string, string]);
  let out: string[];
  if (examples.length) {
    // The examples pin down every open question: read the padding width and the variant separator
    // straight off them, then apply that one rule to every input.
    const width = Math.max(...examples.map(([, dst]) => (/\d+/.exec(dst) ?? [""])[0].length));
    const withVariant = examples.map(([, dst]) => /\d([^\d])[A-Z]+$/.exec(dst)).find((m) => m !== null);
    const sep = withVariant ? withVariant[1] : "-";
    out = codes.map((code) => {
      const [cat, num, v] = split(code);
      return `${cat.toUpperCase()}-${pad(num, width)}${v ? sep + v.toUpperCase() : ""}`;
    });
  } else {
    // Simulated ambiguity: each item gets one of the readings the prose allows.
    out = codes.map((code, i) => {
      const [cat, num, v] = split(code);
      return READINGS[i % READINGS.length](cat, num, v);
    });
  }
  return lab.message([lab.text(JSON.stringify({ codes: out }))]);
}

lab.banner("D3.5  Concrete input/output examples vs a prose description");
const client = lab.getClient(scriptedModel);

lab.section("A. Prose description only");
const proseOut = await normalize(client, buildPrompt(CODES));
CODES.forEach((src, i) => console.log(`  ${JSON.stringify(src).padEnd(14)} -> ${proseOut[i].padEnd(16)} shape ${shape(proseOut[i])}`));

lab.section("B. Same prose + 3 concrete examples");
for (const [src, dst] of EXAMPLES) console.log(`  ${JSON.stringify(src)} -> ${JSON.stringify(dst)}`);
const exampleOut = await normalize(client, buildPrompt(CODES, EXAMPLES));
CODES.forEach((src, i) => console.log(`  ${JSON.stringify(src).padEnd(14)} -> ${exampleOut[i].padEnd(16)} shape ${shape(exampleOut[i])}`));

lab.section("Checks");
const canonical = (codes: string[]) => codes.filter((c) => CANONICAL.test(c)).length;
console.log(`  in the intended format (AA-9999[-VARIANT]): prose ${canonical(proseOut)}/${CODES.length}, examples ${canonical(exampleOut)}/${CODES.length}`);
lab.check(proseOut.length === CODES.length && exampleOut.length === CODES.length, "both prompts returned one code per input (structured output)");
if (!lab.isLive()) {
  lab.check(canonical(proseOut) < CODES.length, "prose alone: padding and variant format come out inconsistent");
  lab.check(JSON.stringify(exampleOut) === JSON.stringify(EXPECTED), "with 3 examples: every code matches the intended format exactly");
}
