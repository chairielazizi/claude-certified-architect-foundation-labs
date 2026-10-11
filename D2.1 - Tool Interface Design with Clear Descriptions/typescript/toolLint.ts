/**
 * Static checks for tool interfaces and system prompts (D2.1).
 *
 *  - lintTool          does each description carry the parts the model needs to choose
 *                      correctly (inputs, outputs, examples, edge cases, when-to-use,
 *                      when-NOT-to-use naming a sibling tool)?
 *  - findOverlaps      token Jaccard similarity between descriptions; near-identical pairs
 *                      (analyze_content vs analyze_document) misroute.
 *  - lintSystemPrompt  keyword-triggered tool instructions ("whenever the user mentions an
 *                      order, call get_customer") that override good descriptions.
 *
 * The tokenizer is also what the offline selector in selectionHarness.ts "reads", so the
 * linter and the stand-in model work from the same evidence.
 */
import type { ToolDef } from "./toolsets.ts";

// Identifier shapes become tokens of their own, so "#12345" in a request can match an
// "accepts #48213" input-format sentence in a description. Input formats are evidence.
const SHAPES: [string, string][] = [
  ["https?://\\S+", "@url"],
  ["[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+", "@email"],
  ["\\bORD-\\d+", "@order_id"],
  ["\\bC-\\d+", "@customer_id"],
  ["#\\d+", "@hash_number"],
];

const STOPWORDS = new Set(
  `an the and or of to in on for from with by at as is are was be been it its this that these
  those my me you your we our us do does did can could would should will what which who whom
  whose when where how any all every some one get give please here there into about than then them
  they their has have had just also only out up so if yet really still am`.split(/\s+/),
);

// A sentence containing one of these is a boundary ("Does not ...", "use X instead"):
// its words are evidence AGAINST choosing the tool, not for it.
const NEGATION = /\b(not|instead|never)\b|n't\b/i;

// A few synonyms stand in for the semantic matching a real model does ("paper" is a
// document). Kept tiny on purpose: everything else must come from the description.
const SYNONYMS: Record<string, string> = {
  paper: "document",
  report: "document",
  pdf: "document",
  filing: "document",
  article: "document",
};

/** Crude suffix stripping so "shipped"/"shipping" and "sources"/"source" meet. */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Content tokens of a text: identifier shapes + stemmed words minus stopwords. */
export function tokens(input: string): Set<string> {
  const found = new Set<string>();
  let text = input;
  for (const [pattern, shape] of SHAPES) {
    if (new RegExp(pattern, "i").test(text)) {
      // Any id-like value is also generic "identifier" evidence: a tool documented
      // only as taking an "Identifier" matches every id (sample Q2's ambiguity).
      found.add(shape);
      found.add("identifier");
      text = text.replace(new RegExp(pattern, "gi"), " ");
    }
  }
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9_]+/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    const word = stem(raw);
    found.add(SYNONYMS[word] ?? word);
  }
  return found;
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split("_")
      .filter((p) => p.length > 0 && !STOPWORDS.has(p))
      .map(stem),
  );
}

const intersectSize = (a: Set<string>, b: Set<string>): number => [...a].filter((x) => b.has(x)).length;

/** [positive, negative] evidence tokens a reader gets from a tool definition. */
export function evidence(tool: ToolDef): [Set<string>, Set<string>] {
  const positive = nameTokens(tool.name);
  const negative = new Set<string>();
  const texts = [tool.description, ...Object.values(tool.input_schema.properties ?? {}).map((p) => p.description ?? "")];
  for (const text of texts) {
    for (const sentence of sentences(text)) {
      const target = NEGATION.test(sentence) ? negative : positive;
      for (const tok of tokens(sentence)) target.add(tok);
    }
  }
  return [positive, negative];
}

/** Score = request tokens a tool's description supports minus those its boundaries reject. */
export function scoreTools(tools: ToolDef[], request: string): [string, number][] {
  const req = tokens(request);
  return tools.map((tool) => {
    const [positive, negative] = evidence(tool);
    return [tool.name, intersectSize(req, positive) - intersectSize(req, negative)] as [string, number];
  });
}

// ---------------------------------------------------------------------------
// Description linter
// ---------------------------------------------------------------------------

export const MIN_DESCRIPTION_CHARS = 200;

const DESCRIPTION_CHECKS: [string, RegExp][] = [
  ["states what it returns", /\breturns?\b/i],
  ["documents the input format", /\b(input|accepts|format|such as)\b/i],
  ["gives example queries", /\bexamples?\b/i],
  ["says when to use it", /\buse (this|it) (when|for|to|only)\b/i],
  ["says when NOT to use it", /\b(does not|do not|not for|instead)\b/i],
  ["covers an edge case", /\bedge cases?\b|\bif no\b|\bwhen no\b/i],
];

const VAGUE_VERBS = new Set(["analyze", "process", "handle", "manage", "do", "run"]);
const VAGUE_NOUNS = new Set(["content", "data", "document", "item", "info", "information", "thing"]);

/** Findings for one tool definition (empty list = clean). */
export function lintTool(tool: ToolDef, siblings: string[]): string[] {
  const desc = tool.description;
  const findings: string[] = [];
  if (desc.length < MIN_DESCRIPTION_CHARS) {
    findings.push(`description is ${desc.length} chars (< ${MIN_DESCRIPTION_CHARS}); too little to differentiate`);
  }
  for (const [label, pattern] of DESCRIPTION_CHECKS) {
    if (!pattern.test(desc)) findings.push(`missing: ${label}`);
  }
  const others = siblings.filter((s) => s !== tool.name);
  if (others.length > 0 && !others.some((o) => desc.includes(o))) {
    findings.push("names no sibling tool (no 'use X instead' boundary)");
  }
  const parts = tool.name.split("_");
  if (VAGUE_VERBS.has(parts[0]) && VAGUE_NOUNS.has(parts[parts.length - 1])) {
    findings.push(`generic name '${tool.name}' - rename or split by purpose`);
  }
  const schema = tool.input_schema;
  if (schema.required === undefined) findings.push("input_schema has no 'required' list (undefined input contract)");
  const undocumented = Object.entries(schema.properties ?? {})
    .filter(([, p]) => (p.description ?? "").length < 12)
    .map(([k]) => k);
  if (undocumented.length > 0) findings.push(`parameters without a useful description: ${JSON.stringify(undocumented)}`);
  return findings;
}

export function lintToolset(tools: ToolDef[]): Record<string, string[]> {
  const names = tools.map((t) => t.name);
  const report: Record<string, string[]> = {};
  for (const t of tools) report[t.name] = lintTool(t, names);
  return report;
}

// ---------------------------------------------------------------------------
// Overlap detector
// ---------------------------------------------------------------------------

export const OVERLAP_THRESHOLD = 0.5;

export function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  return union.size ? intersectSize(a, b) / union.size : 0;
}

function pairs(tools: ToolDef[]): [ToolDef, ToolDef][] {
  const out: [ToolDef, ToolDef][] = [];
  for (let i = 0; i < tools.length; i++) for (let j = i + 1; j < tools.length; j++) out.push([tools[i], tools[j]]);
  return out;
}

/** Pairs of tools whose descriptions are near-identical (likely to be confused). */
export function findOverlaps(tools: ToolDef[], threshold = OVERLAP_THRESHOLD): [string, string, number][] {
  return pairs(tools)
    .map(([a, b]) => [a.name, b.name, Math.round(jaccard(tokens(a.description), tokens(b.description)) * 100) / 100] as [string, string, number])
    .filter((p) => p[2] >= threshold)
    .sort((x, y) => y[2] - x[2]);
}

export function maxSimilarity(tools: ToolDef[]): number {
  return Math.max(0, ...pairs(tools).map(([a, b]) => jaccard(tokens(a.description), tokens(b.description))));
}

// ---------------------------------------------------------------------------
// System-prompt keyword linter
// ---------------------------------------------------------------------------

// "<trigger on a keyword> ... <call|use> <tool>" phrasings. Each captures (keyword, tool).
const KEYWORD_RULES: RegExp[] = [
  /whenever (?:the )?(?:user|customer|message|request)s? (?:mentions?|says|asks about|contains|uses) (?:the word )?(?:an? |the )?['"]?(\w+)['"]?[^.]*?\b(?:call|use|run|invoke) (\w+)/gi,
  /if (?:a|the|any) (?:user )?(?:message|request|question) (?:contains|mentions|includes|says) (?:the word )?['"]?(\w+)['"]?[^.]*?\b(?:call|use|run|invoke) (\w+)/gi,
  /for anything (?:about|related to|involving|mentioning) (?:an? |the )?['"]?(\w+)['"]?[^.]*?\b(?:call|use) (\w+)/gi,
];

/** [keyword, tool] associations the prompt creates. */
export function keywordRules(systemPrompt: string): [string, string][] {
  const found: [string, string][] = [];
  for (const rule of KEYWORD_RULES) {
    for (const m of systemPrompt.matchAll(rule)) found.push([m[1].toLowerCase(), m[2]]);
  }
  return found;
}

export function lintSystemPrompt(systemPrompt: string, toolNames: string[]): string[] {
  return keywordRules(systemPrompt).map(([keyword, tool]) => {
    let msg =
      `keyword trigger '${keyword}' -> ${tool}: any message containing '${keyword}' is pushed to ` +
      `${tool}, overriding the tool descriptions; state the intent/condition instead`;
    if (!toolNames.includes(tool)) msg += ` (and ${tool} is not in the toolset)`;
    return msg;
  });
}
