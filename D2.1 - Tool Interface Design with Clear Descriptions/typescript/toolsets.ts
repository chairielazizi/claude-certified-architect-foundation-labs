/**
 * Two versions of the same toolset, plus system prompts and test requests (D2.1).
 *
 * BAD_TOOLS is what you often find in a first prototype:
 *  - one-line descriptions ("Retrieves customer information" / "Retrieves order details")
 *    with an untyped `id` parameter, so the model cannot tell the two tools apart;
 *  - analyze_content and analyze_document with near-identical descriptions;
 *  - one generic analyze_document doing extraction, summarising and fact checking.
 *
 * GOOD_TOOLS fixes it the way the exam expects:
 *  - expanded descriptions: what it returns, input formats, example queries, edge cases,
 *    and "use X instead when ..." boundaries that name the sibling tool;
 *  - analyze_content renamed extract_web_results with a web-specific description;
 *  - analyze_document split into extract_data_points, summarize_content and
 *    verify_claim_against_source, each with its own input/output contract.
 */

export interface PropDef {
  type: string;
  description?: string;
  items?: { type: string };
}

/** A Messages API tool definition with the schema fields this lab reads. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, PropDef>; required?: string[] };
}

// ---------------------------------------------------------------------------
// Before: minimal, overlapping, generic
// ---------------------------------------------------------------------------

const ID_ONLY: ToolDef["input_schema"] = {
  type: "object",
  properties: { id: { type: "string", description: "Identifier" } },
  required: ["id"],
};

export const BAD_TOOLS: ToolDef[] = [
  { name: "get_customer", description: "Retrieves customer information", input_schema: ID_ONLY },
  { name: "lookup_order", description: "Retrieves order details", input_schema: ID_ONLY },
  {
    name: "analyze_content",
    description: "Analyzes content and returns the analysis.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "analyze_document",
    description: "Analyzes a document and returns the analysis.",
    input_schema: { type: "object", properties: { content: { type: "string" } } },
  },
];

// ---------------------------------------------------------------------------
// After: differentiated descriptions, renamed and split tools
// ---------------------------------------------------------------------------
// Writing style used below (one sentence per idea, so each part is easy to review):
//   what it does + what it returns / input formats / when to use / example queries /
//   edge cases / boundary: what it does NOT do and which sibling tool to use instead.

export const GOOD_TOOLS: ToolDef[] = [
  {
    name: "get_customer",
    description:
      "Look up one customer account (profile) and return customer_id, name, email, phone, " +
      "shipping address and loyalty tier. " +
      "Input: exactly one identifier - a customer_id in the format C-1234, an email address " +
      "such as alice@example.com, or a phone number. " +
      "Use this when the user asks about their account, profile, contact details, address on " +
      "file or loyalty tier, or when you must verify identity before an account change. " +
      'Example queries: "what email do you have for me?", "I\'m alice@example.com, which tier ' +
      'am I?", "update the address on my account". ' +
      'Edge case: returns {"found": false} when no account matches; ask the user to confirm ' +
      "the identifier. " +
      "A bare number like 12345 or #12345 is an order number; send it to lookup_order instead. " +
      "Does not return orders, shipping status or refunds - use lookup_order for anything " +
      "about a specific order.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Customer id, format C-1234" },
        email: { type: "string", description: "Email address on the account" },
        phone: { type: "string", description: "Phone number on the account, digits only" },
      },
      required: [],
    },
  },
  {
    name: "lookup_order",
    description:
      "Fetch one order by its order number and return status, carrier tracking number, " +
      "shipped and delivered dates, items, total and refund status. " +
      "Input: order_id - accepts the forms customers type, such as #48213, 48213 or " +
      "ORD-48213 (normalised server-side). " +
      "Use this for any question about a specific order: where it is, whether it has shipped " +
      "or arrived, tracking, delivery date, what was in it, or the status of its refund. " +
      'Example queries: "is order #48213 on its way?", "has ORD-5521 shipped yet?", ' +
      '"when will my package arrive?". ' +
      'Edge case: returns {"found": false} for an unknown number; ask the customer to ' +
      "re-check it rather than guessing. " +
      "Does not return account or contact details - use get_customer for profile, email, " +
      "address or tier questions.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string", description: "Order number: #48213, 48213 or ORD-48213" } },
      required: ["order_id"],
    },
  },
  {
    // Renamed from analyze_content: the name and description now say WHICH content.
    name: "extract_web_results",
    description:
      "Parse web search results (the title / URL / snippet entries returned by a search engine " +
      "or the web_search tool) and return records [{title, url, domain, published_date, snippet}]. " +
      "Input: results - the raw search-result list or text, plus optional keep_fields. " +
      'Use this only for search-engine result pages and web snippets, for example "pull the ' +
      'titles and links out of these search results" or "which of these web results come ' +
      'from news sites?". ' +
      "Edge case: entries without a date get published_date null, and duplicate URLs are " +
      "merged into one record. " +
      "Not for PDFs, reports or other full documents - use extract_data_points, " +
      "summarize_content or verify_claim_against_source instead.",
    input_schema: {
      type: "object",
      properties: {
        results: { type: "string", description: "Raw search results (JSON list or pasted text)" },
        keep_fields: { type: "array", items: { type: "string" }, description: "Subset of fields to keep" },
      },
      required: ["results"],
    },
  },
  {
    // Split 1/3 of the old generic analyze_document.
    name: "extract_data_points",
    description:
      "Extract specific facts from one full document (PDF, annual report, paper, filing) and " +
      "return records [{field, value, unit, page, quote}]. " +
      "Input: document_text plus fields - the names of the data points wanted, such as " +
      '["revenue", "fiscal_year"]. ' +
      "Use this when the user wants numbers, figures, dates, names or other discrete values " +
      "pulled out of a document. " +
      'Example: "get every revenue figure and its year from this annual report". ' +
      "Edge case: a requested field that is absent comes back with value null and " +
      "found false; it is never invented. " +
      "Does not summarise or judge claims - use summarize_content or " +
      "verify_claim_against_source instead.",
    input_schema: {
      type: "object",
      properties: {
        document_text: { type: "string", description: "Full text of ONE document" },
        fields: { type: "array", items: { type: "string" }, description: "Data points to extract" },
      },
      required: ["document_text", "fields"],
    },
  },
  {
    // Split 2/3.
    name: "summarize_content",
    description:
      "Write a summary of one document or passage and return {summary, key_points[], " +
      "word_count}. " +
      "Input: text plus max_sentences (default 5) and an optional focus such as " +
      '"methods" or "findings". ' +
      "Use this when the user wants the gist, an overview, a TL;DR or a shorter version of a " +
      "paper, article or report. " +
      "Example: \"give me a short overview of this paper's findings\". " +
      "Edge case: text under 50 words is returned unchanged with note too_short. " +
      "Does not pull out exact figures or check claims - use extract_data_points or " +
      "verify_claim_against_source instead.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Document or passage to summarise" },
        max_sentences: { type: "integer", description: "Upper bound on summary length" },
        focus: { type: "string", description: "Optional aspect to emphasise" },
      },
      required: ["text"],
    },
  },
  {
    // Split 3/3.
    name: "verify_claim_against_source",
    description:
      "Check whether a source document supports, contradicts or is silent on one specific " +
      "claim, and return {verdict: supported|contradicted|not_found, evidence_quote, " +
      "confidence}. " +
      "Input: claim (one sentence) and source_text. " +
      "Use this when the user asks whether a document backs up, confirms, proves or disputes " +
      "a statement. " +
      'Example: "does this report really say streaming revenue grew 12%?". ' +
      "Edge case: if the source is silent on the claim the verdict is not_found, never " +
      "supported. " +
      "Does not search the web for new sources - it only checks the text you pass in; for " +
      "search results use extract_web_results.",
    input_schema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "The single claim to check" },
        source_text: { type: "string", description: "Text of the source document" },
      },
      required: ["claim", "source_text"],
    },
  },
];

/** Where each old tool went. Used to map expected answers onto the "before" toolset. */
export const RENAMES: Record<string, string> = {
  get_customer: "get_customer",
  lookup_order: "lookup_order",
  extract_web_results: "analyze_content", // renamed
  extract_data_points: "analyze_document", // split
  summarize_content: "analyze_document", // split
  verify_claim_against_source: "analyze_document", // split
};

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

/** States the business rule by intent ("before an account change"), not by keyword. */
export const REVIEWED_SYSTEM_PROMPT =
  "You are a support and research assistant for an electronics retailer. " +
  "Pick the tool whose description matches the user's goal. " +
  "Before any change to an account or a refund, confirm the customer's identity with " +
  "get_customer; read-only order status questions can go straight to lookup_order.";

/**
 * Keyword-sensitive wording: it creates tool associations nobody intended. "order" now
 * means get_customer, and any message mentioning a "source" goes to the claim checker.
 */
export const KEYWORD_TRAP_SYSTEM_PROMPT =
  "You are a support and research assistant for an electronics retailer. " +
  "Whenever the user mentions an order, call get_customer first so we know who they are. " +
  "If a message contains the word 'source', use verify_claim_against_source.";

// ---------------------------------------------------------------------------
// Ambiguous requests with the tool a careful human would pick (GOOD_TOOLS names)
// ---------------------------------------------------------------------------

export const REQUESTS: [string, string][] = [
  ["check my order #12345", "lookup_order"],
  ["Has my package shipped yet? It's ORD-5521.", "lookup_order"],
  ["Where is my refund for order #77812?", "lookup_order"],
  ["What email address do you have on file for me? My id is C-1001.", "get_customer"],
  ["I'm alice@example.com - which loyalty tier am I on?", "get_customer"],
  ["Here are web search results for 'AI in film' - list the articles with their links.", "extract_web_results"],
  ["From these search engine snippets, which sources are news sites?", "extract_web_results"],
  ["Extract every revenue figure and its fiscal year from this annual report PDF.", "extract_data_points"],
  ["Give me a short overview of this research paper.", "summarize_content"],
  ["Does the attached report really back up the claim that streaming revenue grew 12%?", "verify_claim_against_source"],
];
