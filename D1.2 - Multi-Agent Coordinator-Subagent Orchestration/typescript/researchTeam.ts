/**
 * The D1.2 research team: role prompts, output contracts, and the offline stand-in model.
 *
 * Hub-and-spoke: only the coordinator (coordinator.ts) talks to these roles. A role is defined
 * by its system prompt and its output schema, nothing else. Each call it receives is a brand-new
 * conversation holding ONE user message (its task), so a subagent can only know what the
 * coordinator chose to write into that task.
 *
 * Offline, `scriptedTeam` stands in for Claude. One function plays every role: it dispatches on
 * the system prompt, then decides from the task text it was given. The corpus is fictional and
 * exists only for the offline demo.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

/** Subagent roles, in pipeline order. The coordinator picks a subset per query. */
export const ROLES = ["web_search", "document_analysis", "synthesis", "report"] as const;
export type Role = (typeof ROLES)[number];
export type ResearchRole = "web_search" | "document_analysis";

// The first line of every prompt is a role tag; the offline responder dispatches on it.
export const COORDINATOR_PROMPT =
  "ROLE: research coordinator\n" +
  "You plan work for a research team: web_search (news and web articles), document_analysis " +
  "(research reports and academic papers), synthesis (combines findings and reports coverage gaps) " +
  "and report (writes the final cited report).\n" +
  "Match the machinery to the query. A single verifiable fact needs only web_search. A broad topic " +
  "needs the full pipeline and a decomposition into subtopics that together cover every major sector " +
  "of the topic, with no two subtopics covering the same ground.\n" +
  "Return JSON with complexity, rationale, subagents and subtopics.";

export const SUBAGENT_PROMPTS: Record<Role, string> = {
  web_search:
    "ROLE: web_search subagent\n" +
    "You research ONE assigned slice of a topic using news and web articles only. Stay inside your " +
    "slice and source type; other agents cover the rest. For each finding give the claim, a short " +
    "evidence excerpt, the source URL, the title and the publication date. Return JSON.",
  document_analysis:
    "ROLE: document_analysis subagent\n" +
    "You analyse research reports and academic papers for ONE assigned slice of a topic. For each " +
    "finding give the claim, a short evidence excerpt, the document name, the page and the " +
    "publication date. If nothing matches, return an empty list rather than stretching. Return JSON.",
  synthesis:
    "ROLE: synthesis subagent\n" +
    "Combine the findings you are given into key points per dimension, citing finding ids. Then judge " +
    "coverage: every required dimension needs at least one web finding and one document finding. " +
    "Report each gap as data: the dimension, what is missing, which subagent should fill it " +
    "(web_search or document_analysis) and a targeted query. coverage_sufficient is true only when " +
    "there are no gaps. Return JSON.",
  report:
    "ROLE: report subagent\n" +
    "Write the final research report from the synthesis and source list you are given. One line per " +
    "dimension, cite sources inline as [F#], end with the source list. Use only what you are given.",
};

// ---------------------------------------------------------------------------
// Output contracts (sent as output_config.format in live mode)
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

/** JSON-schema object with every property required and no extras (what structured outputs expect). */
function obj(properties: Record<string, Schema>): Schema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const STR: Schema = { type: "string" };
const WEB_FINDING = obj({ claim: STR, evidence: STR, source_url: STR, title: STR, publication_date: STR });
const DOC_FINDING = obj({ claim: STR, evidence: STR, document_name: STR, page: { type: "integer" }, publication_date: STR });

export const OUTPUT_SCHEMAS: Record<string, Schema> = {
  coordinator: obj({
    complexity: { type: "string", enum: ["simple", "broad"] },
    rationale: STR,
    subagents: { type: "array", items: { type: "string", enum: [...ROLES] } },
    subtopics: { type: "array", items: obj({ id: STR, focus: STR }) },
  }),
  web_search: obj({ findings: { type: "array", items: WEB_FINDING } }),
  document_analysis: obj({ findings: { type: "array", items: DOC_FINDING } }),
  synthesis: obj({
    key_points: {
      type: "array",
      items: obj({ dimension: STR, point: STR, finding_ids: { type: "array", items: STR } }),
    },
    coverage_gaps: {
      type: "array",
      items: obj({
        dimension: STR,
        missing: STR,
        target_role: { type: "string", enum: ["web_search", "document_analysis"] },
        suggested_query: STR,
      }),
    },
    coverage_sufficient: { type: "boolean" },
  }),
};

export function jsonOutput(role: string): { format: { type: "json_schema"; schema: Schema } } {
  return { format: { type: "json_schema", schema: OUTPUT_SCHEMAS[role] } };
}

/** Contents of <name>...</name> in a task prompt ("" if absent). */
export function tag(text: string, name: string): string {
  const match = text.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`));
  return match ? match[1] : "";
}

// Shapes the coordinator and the subagents exchange.
export interface Subtopic {
  id: string;
  focus: string;
}
export interface RawFinding {
  claim: string;
  evidence: string;
  publication_date: string;
  source_url?: string;
  title?: string;
  document_name?: string;
  page?: number;
}
export interface Finding {
  id: string;
  dimension: string;
  source_type: string;
  claim: string;
  citation: string;
}
export interface Gap {
  dimension: string;
  missing: string;
  target_role: ResearchRole;
  suggested_query: string;
}
export interface Synthesis {
  key_points: { dimension: string; point: string; finding_ids: string[] }[];
  coverage_gaps: Gap[];
  coverage_sufficient: boolean;
}

// ---------------------------------------------------------------------------
// Fictional corpus (offline only)
// ---------------------------------------------------------------------------

interface CorpusEntry {
  keywords: string[];
  [field: string]: unknown;
}

const WEB_CORPUS: CorpusEntry[] = [
  {
    keywords: ["ai act"],
    claim: "The EU AI Act entered into force on 1 August 2024; its obligations phase in over the following years.",
    evidence: "The regulation entered into force on 1 August 2024 ...",
    source_url: "https://example.org/eu-ai-act-timeline",
    title: "EU AI Act: the implementation timeline",
    publication_date: "2024-08-01",
  },
  {
    keywords: ["visual art", "digital art", "graphic design", "photography", "illustration"],
    claim: "Freelance illustrators and stock photographers report fewer commissions as marketing teams adopt image generators.",
    evidence: "'My stock-style work dried up within a year,' one illustrator said ...",
    source_url: "https://example.org/news/illustrators-and-image-generators",
    title: "Illustrators feel the squeeze from image generators",
    publication_date: "2026-02-11",
  },
  {
    keywords: ["music"],
    claim: "Record labels are licensing catalogues to AI music start-ups while suing unlicensed generators.",
    evidence: "The licensing deal follows two lawsuits filed earlier this year ...",
    source_url: "https://example.org/news/labels-license-ai-music",
    title: "Labels split strategy on AI music",
    publication_date: "2026-04-02",
  },
  {
    keywords: ["writing", "publishing"],
    claim: "Publishers report a surge in AI-assisted manuscript submissions and are adding disclosure rules.",
    evidence: "Submissions doubled; the new policy requires authors to disclose AI assistance ...",
    source_url: "https://example.org/news/publishers-ai-disclosure",
    title: "Publishers add AI disclosure requirements",
    publication_date: "2026-01-20",
  },
  {
    keywords: ["film", "video"],
    claim: "Studios use generative tools for pre-visualisation, and union agreements now regulate digital replicas of performers.",
    evidence: "The agreement requires consent and compensation for any digital replica ...",
    source_url: "https://example.org/news/studios-previs-digital-replicas",
    title: "Generative previs goes mainstream on film sets",
    publication_date: "2026-05-18",
  },
];

const DOC_CORPUS: CorpusEntry[] = [
  {
    keywords: ["visual art", "digital art", "graphic design", "photography"],
    claim: "38% of surveyed illustrators lost at least one recurring client to AI tools.",
    evidence: "Table 4: client loss by discipline ...",
    document_name: "Creative Labour Survey 2026",
    page: 14,
    publication_date: "2026-03-01",
  },
  {
    keywords: ["music"],
    claim: "Licensed AI-training deals became a growing share of music publishing income.",
    evidence: "Section 2.3: new revenue lines ...",
    document_name: "Music Rights Review 2026",
    page: 7,
    publication_date: "2026-02-15",
  },
  {
    keywords: ["writing", "publishing"],
    claim: "Translation and copy-editing are the publishing roles most exposed to automation.",
    evidence: "Figure 9: exposure index by role ...",
    document_name: "Publishing Futures Report",
    page: 22,
    publication_date: "2025-11-30",
  },
  {
    // Indexed under VFX terminology only, so a generic "film" query misses it. The refinement
    // loop exists for exactly this: a targeted follow-up query finds it.
    keywords: ["visual effects", "vfx", "animation"],
    claim: "VFX houses are automating rotoscoping and clean-up, shifting junior roles toward supervision.",
    evidence: "Chapter 3: task automation in post-production ...",
    document_name: "Screen Industries VFX Workforce Study",
    page: 31,
    publication_date: "2026-06-01",
  },
];

/** Follow-up queries the synthesis agent proposes for a gap (it "knows" the field's vocabulary). */
const TARGETED_QUERIES: Record<string, string> = {
  "film|document_analysis": "AI in visual effects (VFX) and animation: workforce studies",
};

/** Subtopics a well-prompted coordinator produces for the broad demo topic. */
export const CREATIVE_SUBTOPICS: Subtopic[] = [
  { id: "st1", focus: "AI in visual arts: digital art, graphic design and photography" },
  { id: "st2", focus: "AI in music composition and production" },
  { id: "st3", focus: "AI in writing and publishing" },
  { id: "st4", focus: "AI in film and video production" },
];

// ---------------------------------------------------------------------------
// Offline stand-in for Claude, one handler per role
// ---------------------------------------------------------------------------

type Handler = (params: lab.CreateParams) => Anthropic.Message;

function reply(payload: unknown): Anthropic.Message {
  return lab.message([lab.text(typeof payload === "string" ? payload : JSON.stringify(payload))]);
}

const firstLine = (text: string) => text.split("\n")[0];

export function isFactualQuestion(query: string): boolean {
  return /^\s*(when|what year|who|how many)\b/i.test(query) && query.split(/\s+/).filter(Boolean).length <= 16;
}

const plan: Handler = (params) => {
  const first = params.messages[0].content;
  const query = typeof first === "string" ? first : "";
  if (isFactualQuestion(query)) {
    return reply({
      complexity: "simple",
      rationale: "One verifiable fact: a single targeted search answers it; synthesis and a report add latency, not coverage.",
      subagents: ["web_search"],
      subtopics: [{ id: "q1", focus: query }],
    });
  }
  const subtopics = query.toLowerCase().includes("creative industries")
    ? CREATIVE_SUBTOPICS
    : [
        { id: "st1", focus: `${query}: current evidence` },
        { id: "st2", focus: `${query}: open questions` },
      ];
  return reply({
    complexity: "broad",
    rationale: "Broad topic spanning several sectors: partition by sector and source type, then synthesise and report.",
    subagents: [...ROLES],
    subtopics,
  });
};

function search(corpus: CorpusEntry[], fields: string[]): Handler {
  return (params) => {
    const focus = tag(lab.lastUserText(params), "slice").toLowerCase();
    const hits = corpus.filter((doc) => doc.keywords.some((k) => focus.includes(k)));
    return reply({ findings: hits.map((doc) => Object.fromEntries(fields.map((f) => [f, doc[f]]))) });
  };
}

const synthesize: Handler = (params) => {
  const task = lab.lastUserText(params);
  const required = JSON.parse(tag(task, "required_dimensions") || "[]") as string[];
  const findings = JSON.parse(tag(task, "findings") || "[]") as Finding[];
  const keyPoints: Synthesis["key_points"] = [];
  const gaps: Gap[] = [];
  for (const dim of required) {
    const mine = findings.filter((f) => f.dimension === dim);
    if (mine.length) {
      keyPoints.push({ dimension: dim, point: mine.map((f) => f.claim).join(" "), finding_ids: mine.map((f) => f.id) });
    }
    const kinds: [string, ResearchRole, string][] = [
      ["web", "web_search", "web"],
      ["documents", "document_analysis", "document"],
    ];
    for (const [sourceType, role, label] of kinds) {
      if (!mine.some((f) => f.source_type === sourceType)) {
        const fallback = `AI in ${dim.replaceAll("_", " ")}: ${role === "web_search" ? "news coverage" : "reports and papers"}`;
        gaps.push({
          dimension: dim,
          missing: `no ${label} evidence`,
          target_role: role,
          suggested_query: TARGETED_QUERIES[`${dim}|${role}`] ?? fallback,
        });
      }
    }
  }
  return reply({ key_points: keyPoints, coverage_gaps: gaps, coverage_sufficient: gaps.length === 0 });
};

const report: Handler = (params) => {
  const task = lab.lastUserText(params);
  const synthesis = JSON.parse(tag(task, "synthesis")) as Synthesis;
  const sources = JSON.parse(tag(task, "sources")) as { id: string; citation: string }[];
  const lines = [`Research report: ${tag(task, "topic")}`];
  for (const point of synthesis.key_points) {
    lines.push(`- ${point.dimension}: ${point.point} ${point.finding_ids.map((i) => `[${i}]`).join("")}`);
  }
  lines.push("Sources:", ...sources.map((s) => `  [${s.id}] ${s.citation}`));
  return reply(lines.join("\n"));
};

const HANDLERS: Record<string, Handler> = {
  [firstLine(COORDINATOR_PROMPT)]: plan,
  [firstLine(SUBAGENT_PROMPTS.web_search)]: search(WEB_CORPUS, ["claim", "evidence", "source_url", "title", "publication_date"]),
  [firstLine(SUBAGENT_PROMPTS.document_analysis)]: search(DOC_CORPUS, ["claim", "evidence", "document_name", "page", "publication_date"]),
  [firstLine(SUBAGENT_PROMPTS.synthesis)]: synthesize,
  [firstLine(SUBAGENT_PROMPTS.report)]: report,
};

/** Which role a request is addressed to (from the role tag on its system prompt). */
export function roleOf(params: lab.CreateParams): string {
  return firstLine(lab.systemText(params)).replace(/^ROLE: /, "").replace(/ subagent$/, "").replace("research ", "");
}

/** Offline stand-in for every role: dispatch on the system prompt's role tag. */
export function scriptedTeam(params: lab.CreateParams): Anthropic.Message {
  const handler = HANDLERS[firstLine(lab.systemText(params))];
  if (!handler) throw new Error("scriptedTeam: unknown role");
  return handler(params);
}
