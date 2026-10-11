/**
 * Context layers for a long support session (shared by the D5.1 demos).
 *
 * Every request in the case-facts pipeline is assembled from three layers:
 *
 *   system prompt
 *     + <case_facts>      amounts, dates, order IDs, customer expectations  (extracted, never summarized)
 *     + <open_issues>     one row per issue: id, order, amount, status      (separate layer, multi-issue)
 *     + <conversation_summary>                                          (lossy, re-summarized each round)
 *   messages = the most recent turns verbatim + the new user message
 *
 * The scripted models are "model-driven" in the way that matters here: the summarizer
 * compresses whatever text it is given (keeping the gist and dropping specifics, the
 * documented failure mode), and the support agent can only repeat facts that are actually
 * visible in its prompt. In live mode the same code calls the real API.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import * as lab from "../../shared/typescript/labkit.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf-8"));
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}
export interface Conversation {
  customer: string;
  turns: Turn[];
  final_question: string;
}

/** One structured fact from a research subagent (fixtures/subagent_findings.json). */
export interface Fact {
  id: string;
  fact: string;
  relevance: number;
  source: string;
  location: string;
  date: string;
}
export interface AgentFindings {
  agent: string;
  scope: string;
  methodology: string;
  working_log: string[];
  verbose: string;
  facts: Fact[];
}

export const AGENT_SYSTEM_PROMPT =
  "You are a customer support agent for an online electronics store. " +
  "The <case_facts> and <open_issues> blocks, when present, are authoritative and current; " +
  "prefer them over the conversation summary. Quote exact amounts, dates and order IDs.";
export const SUMMARIZER_PROMPT = "Summarize this customer support conversation in a few short sentences.";

// Summarize the oldest SUMMARIZE_BATCH turns once the verbatim buffer reaches this size.
export const BUFFER_LIMIT = 6;
export const SUMMARIZE_BATCH = 4;

const ORDER_RE = /ORD-\d{4}/;
const AMOUNT_RE = /\$\d+\.\d{2}/;
const DATED_EVENT_RE = /\b(paid|delivered|charged)\b[^\n]*? on (\d{4}-\d{2}-\d{2})/g;
const STATUS_RE = /status: ([a-z_]+)/;
const EXPECTATION_RE = /\bI expect ([^.]+)\./g;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const DATE_LABELS: Record<string, string> = { paid: "purchased_on", delivered: "delivered_on", charged: "charged_on" };

// ---------------------------------------------------------------------------
// The persistent layers: case facts + issues
// ---------------------------------------------------------------------------

/** Transactional facts and customer-stated expectations, kept verbatim. */
export class CaseFacts {
  customer: string | null = null;
  orders: Record<string, Record<string, string>> = {};
  expectations: string[] = [];

  render(): string {
    const lines = ["<case_facts>", `customer: ${this.customer ?? "unknown"}`, "orders:"];
    for (const [orderId, facts] of Object.entries(this.orders)) {
      lines.push(`  ${orderId}: ` + Object.entries(facts).map(([k, v]) => `${k} ${v}`).join("; "));
    }
    lines.push("customer_expectations:");
    if (this.expectations.length) lines.push(...this.expectations.map((e) => `  - "${e}"`));
    else lines.push("  - none stated");
    lines.push("</case_facts>");
    return lines.join("\n");
  }
}

export interface Issue {
  issue_id: string;
  order_id: string;
  amount: string;
  status: string;
}

/** One structured row per issue so a multi-issue session never blends issues together. */
export class IssueLayer {
  issues: Issue[] = [];

  forOrder(orderId: string): Issue {
    const existing = this.issues.find((i) => i.order_id === orderId);
    if (existing) return existing;
    const issue: Issue = { issue_id: `ISS-${this.issues.length + 1}`, order_id: orderId, amount: "unknown", status: "open" };
    this.issues.push(issue);
    return issue;
  }

  render(): string {
    const lines = ["<open_issues>", "| issue | order | amount | status |", "|---|---|---|---|"];
    for (const i of this.issues) lines.push(`| ${i.issue_id} | ${i.order_id} | ${i.amount} | ${i.status} |`);
    lines.push("</open_issues>");
    return lines.join("\n");
  }
}

/**
 * Pull facts out of a turn BEFORE it can ever be summarized.
 *
 * Deterministic regexes stand in for the production approach (read transactional facts
 * straight from tool results, and use a structured-output extraction call for what the
 * customer says). The point of the lab is where the facts live, not how they are parsed.
 */
export function extractFacts(turn: Turn, facts: CaseFacts, issues: IssueLayer): void {
  const text = turn.text;
  const email = text.match(EMAIL_RE);
  if (email && facts.customer === null) facts.customer = email[0];
  const order = text.match(ORDER_RE); // each turn in the fixture is about at most one order
  if (order) {
    const orderId = order[0];
    const orderFacts = (facts.orders[orderId] ??= {});
    const amount = text.match(AMOUNT_RE);
    if (amount && !("amount" in orderFacts)) orderFacts.amount = amount[0];
    for (const event of text.matchAll(DATED_EVENT_RE)) {
      const label = DATE_LABELS[event[1]];
      if (!(label in orderFacts)) orderFacts[label] = event[2];
    }
    const issue = issues.forOrder(orderId);
    if ("amount" in orderFacts) issue.amount = orderFacts.amount;
    const status = text.match(STATUS_RE);
    if (status) issue.status = status[1]; // latest status wins: the layer is always current
  }
  if (turn.role === "user") {
    for (const expectation of text.matchAll(EXPECTATION_RE)) {
      if (!facts.expectations.includes(expectation[1])) facts.expectations.push(expectation[1]);
    }
  }
}

export function buildSystemPrompt(summary: string, facts: CaseFacts | null, issues: IssueLayer | null): string {
  const parts = [AGENT_SYSTEM_PROMPT];
  if (facts && issues) parts.push(facts.render(), issues.render()); // OUTSIDE the summarized history
  parts.push(`<conversation_summary>\n${summary || "(nothing summarized yet)"}\n</conversation_summary>`);
  return parts.join("\n\n");
}

/** One round of progressive summarization: (previous summary + oldest turns) -> new summary. */
export async function summarize(client: lab.MessagesClient, previousSummary: string, turns: Turn[]): Promise<string> {
  const transcript = turns.map((t) => `${t.role}: ${t.text}`).join("\n");
  const prompt =
    `Previous summary:\n${previousSummary || "(none)"}\n\n` + `New turns:\n${transcript}\n\nWrite the updated summary.`;
  const response = await client.messages.create({
    model: lab.MODEL,
    max_tokens: 16000,
    system: SUMMARIZER_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  return lab.textOf(response).trim();
}

/** Everything the model can see in a request: system prompt plus every message's text. */
export function visibleText(params: lab.CreateParams): string {
  const parts = [lab.systemText(params)];
  for (const msg of params.messages) {
    if (typeof msg.content === "string") parts.push(msg.content);
    else for (const b of msg.content) parts.push(b.type === "text" ? b.text : "");
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Offline stand-ins for Claude
// ---------------------------------------------------------------------------

type Rule = [RegExp, string];
// New turns lose dates and deadlines; re-summarizing an old summary also loses amounts,
// order IDs and statuses. That is "progressive" loss: each round is a little vaguer.
const LIGHT_VAGUE: Rule[] = [
  [/ on \d{4}-\d{2}-\d{2}/g, " recently"],
  [/\d{4}-\d{2}-\d{2}/g, "recently"],
  [/by (?:Monday|Tuesday|Wednesday|Thursday|Friday)/g, "soon"],
];
const HEAVY_VAGUE: Rule[] = [
  ...LIGHT_VAGUE,
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "the customer"],
  [/\$\d+(?:\.\d{2})?/g, "a payment"],
  [/ORD-\d{4}/g, "an order"],
  [/status: [a-z_]+/g, "in progress"],
];
const OLD_SUMMARY_BUDGET = 220; // chars of the previous summary that survive each re-summarization

function vague(text: string, rules: Rule[]): string {
  let out = text;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

export function sentences(text: string): string[] {
  // A sentence ends at . ? or ! followed by whitespace, so "$129.00" stays in one piece.
  return (text.match(/.+?(?:[.?!](?=\s|$)|$)/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function longestSentence(text: string): string {
  let best = "";
  for (const s of sentences(text)) if (s.length > best.length) best = s;
  return best;
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start) + start.length;
  const to = source.indexOf(end, from);
  return to < 0 ? source.slice(from) : source.slice(from, to);
}

function scriptedSummarizer(params: lab.CreateParams): Anthropic.Message {
  const source = lab.lastUserText(params);
  const previous = between(source, "Previous summary:\n", "\n\nNew turns:\n");
  const newTurns = between(source, "\n\nNew turns:\n", "\n\nWrite the updated summary.");

  const kept: string[] = [];
  if (previous !== "(none)") {
    for (const s of sentences(vague(previous, HEAVY_VAGUE))) {
      if ([...kept, s].join(" ").length > OLD_SUMMARY_BUDGET) break;
      kept.push(s);
    }
  }
  const gists = newTurns.split("\n").map((line) => {
    const cut = line.indexOf(": ");
    const role = line.slice(0, cut);
    const text = line.slice(cut + 2);
    return (role === "user" ? "Customer: " : "Agent: ") + longestSentence(vague(text, LIGHT_VAGUE));
  });
  return lab.message([lab.text([...kept, ...gists].join(" "))]);
}

const ISSUE_ROW_RE = /^\| (ISS-\d+) \| (ORD-\d{4}) \| (\$\d+\.\d{2}|unknown) \| ([a-z_]+) \|$/gm;
const PROMISE_RE = /^ {2}- "([^"]+)"$/gm;
const STATUS_SENTENCE_RE = /(\$\d+\.\d{2})[^.]*?(ORD-\d{4}), status: ([a-z_]+)/g;

/** Answers the recap question using ONLY what is visible in the request. */
function scriptedAgent(params: lab.CreateParams): Anthropic.Message {
  const visible = visibleText(params);
  const rows = [...visible.matchAll(ISSUE_ROW_RE)];
  const promises = [...visible.matchAll(PROMISE_RE)].map((m) => m[1]);
  if (rows.length) {
    const statusText = rows.map((r) => `${r[2]} (${r[3]}) is ${r[4].replaceAll("_", " ")}`).join("; ");
    let reply = `Here is where everything stands: ${statusText}.`;
    if (promises.length) reply += ` And as promised, you will get ${promises[0]}.`;
    return lab.message([lab.text(reply)]);
  }

  // No structured layer: all the model has is the summary and the last few turns.
  const latest = new Map<string, [string, string]>();
  for (const m of visible.matchAll(STATUS_SENTENCE_RE)) latest.set(m[2], [m[1], m[3]]);
  const seen = [...latest.entries()].map(([order, [amount, status]]) => `${order} (${amount}) is ${status.replaceAll("_", " ")}`).join("; ");
  const reply =
    (seen ? `Here is what I can see: ${seen}. ` : "") +
    "Anything else we discussed earlier is still in progress, and we will follow up with you soon.";
  return lab.message([lab.text(reply)]);
}

/** One responder for both roles; the system prompt says which job this call is. */
export function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  return lab.systemText(params).startsWith(SUMMARIZER_PROMPT) ? scriptedSummarizer(params) : scriptedAgent(params);
}
