/**
 * D2.3 - Replace a generic tool with a constrained one: fetch_url -> load_document.
 *
 * fetch_url will fetch anything the model asks for: plain http, internal hosts, cloud metadata
 * endpoints, file:// paths, executables. The web search agent only ever needs DOCUMENTS from
 * known sources, so load_document validates the URL first:
 *   - https only, default port only
 *   - no credentials in the URL (https://arxiv.org@evil.example/... is evil.example)
 *   - no IP literals (blocks 169.254.169.254, 10.x, ::1)
 *   - host on an allowlist (exact domain or a subdomain of it)
 *   - path ends in a document extension (.pdf .html .htm .txt .md), no '..' segments
 *
 * A rejected URL comes back as a structured validation error (see D2.2), so the agent knows to
 * pick a different source instead of retrying.
 *
 * Always offline (nothing is actually fetched). Run:  npx tsx constrainedTools.ts
 */
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";

const ALLOWED_DOMAINS = ["arxiv.org", "sec.gov", "who.int", "nature.com", "docs.example-research.org"];
const DOCUMENT_EXTENSIONS = [".pdf", ".html", ".htm", ".txt", ".md"];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export const LOAD_DOCUMENT_TOOL = {
  name: "load_document",
  description:
    "Load a document (PDF, HTML, plain text or Markdown) from an allowlisted research source " +
    `and return {url, content_type, text}. Input: url - https only, host in ${JSON.stringify(ALLOWED_DOMAINS)} ` +
    "or a subdomain, path ending in .pdf/.html/.htm/.txt/.md. Rejected URLs return a validation " +
    "error with the reason; choose another source rather than retrying the same URL. " +
    "Not a general web fetcher - use web_search to find candidate documents first.",
  input_schema: {
    type: "object" as const,
    properties: { url: { type: "string", description: "https URL of one document" } },
    required: ["url"],
    additionalProperties: false,
  },
};

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** null if acceptable, otherwise the reason it is rejected. */
export function validateDocumentUrl(raw: string): string | null {
  // Checked on the raw string: the WHATWG URL parser would silently normalise '..' away.
  if (raw.includes("/..")) return "path traversal ('..') is not allowed";
  const url = parseUrl(raw);
  if (!url) return "not a valid URL";
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "https") return `scheme '${scheme}' not allowed; https only`;
  if (url.username || url.password) return "credentials in the URL are not allowed (the real host is after the '@')";
  const host = url.hostname.toLowerCase();
  if (!host) return "missing host";
  if (IPV4.test(host) || host.includes(":")) return "IP-literal hosts are not allowed";
  if (url.port !== "" && url.port !== "443") return `port ${url.port} not allowed`;
  if (!ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d))) return `host '${host}' is not on the document allowlist`;
  const pathname = url.pathname.toLowerCase();
  if (!DOCUMENT_EXTENSIONS.some((ext) => pathname.endsWith(ext))) {
    return `path '${url.pathname}' is not a document (${DOCUMENT_EXTENSIONS.join("/")})`;
  }
  return null;
}

/** [payload, isError]. Fetching is simulated; validation is real. */
export function loadDocument(url: string): [Record<string, unknown>, boolean] {
  const reason = validateDocumentUrl(url);
  if (reason) {
    return [
      {
        errorCategory: "validation",
        isRetryable: false,
        message: `load_document rejected the URL: ${reason}. Choose a different source.`,
        details: { field: "url", received: url, reason },
      },
      true,
    ];
  }
  const extension = path.posix.extname(new URL(url).pathname).toLowerCase();
  const types: Record<string, string> = { ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown" };
  return [{ url, content_type: types[extension] ?? "text/html", text: `<simulated contents of ${url}>` }, false];
}

/** The generic tool being replaced: no checks at all. */
export function fetchUrl(url: string): [Record<string, unknown>, boolean] {
  return [{ url, text: `<whatever ${url} returns>` }, false];
}

// [url, should load_document accept it?]
const CASES: [string, boolean][] = [
  ["https://arxiv.org/pdf/2401.12345v2.pdf", true],
  ["https://www.sec.gov/Archives/edgar/data/320193/aapl-10k.htm", true],
  ["https://www.nature.com/articles/s41586-024-07000-1.pdf", true],
  ["https://docs.example-research.org/reports/ai-in-film.md", true],
  ["http://arxiv.org/pdf/2401.12345v2.pdf", false],
  ["https://arxiv.org.evil.example/paper.pdf", false],
  ["https://arxiv.org@evil.example/paper.pdf", false],
  ["https://169.254.169.254/latest/meta-data/iam.txt", false],
  ["file:///etc/passwd", false],
  ["https://arxiv.org/abs/2401.12345", false],
  ["https://who.int/downloads/installer.exe", false],
  ["https://arxiv.org:8443/pdf/2401.12345v2.pdf", false],
  ["https://arxiv.org/pdf/../../admin/secrets.pdf", false],
];

if (lab.isMain(import.meta.url)) {
  lab.banner("D2.3  Constrained tool: load_document instead of fetch_url");

  lab.section("Validation table");
  const results: [boolean, boolean][] = [];
  for (const [url, expected] of CASES) {
    const [payload, isError] = loadDocument(url);
    const accepted = !isError;
    results.push([accepted === expected, accepted]);
    const reason = accepted ? "" : String((payload.details as Record<string, unknown>).reason);
    console.log(`  ${accepted ? "load  " : "REJECT"} ${url.padEnd(62)} ${reason}`);
  }

  lab.section("The same URLs through generic fetch_url");
  const fetched = CASES.filter(([url]) => !fetchUrl(url)[1]).length;
  console.log(`  fetch_url would fetch ${fetched}/${CASES.length} of them, including the metadata endpoint and file://`);

  lab.section("Error the agent sees for a rejected URL");
  lab.show("tool_result content", loadDocument("https://169.254.169.254/latest/meta-data/iam.txt")[0]);

  lab.section("Checks");
  lab.check(results.every(([ok]) => ok), `all ${CASES.length} URL cases behave as specified`);
  lab.check(results.filter(([, accepted]) => accepted).length === 4, "only the 4 allowlisted https document URLs load");
  lab.check(fetched === CASES.length, "the generic fetch_url accepts every URL (why it was replaced)");
  lab.check(LOAD_DOCUMENT_TOOL.input_schema.additionalProperties === false, "load_document takes exactly one url argument");
}
