"""D2.3 - Replace a generic tool with a constrained one: fetch_url -> load_document.

``fetch_url`` will fetch anything the model asks for: plain http, internal hosts, cloud
metadata endpoints, file:// paths, executables. The web search agent only ever needs
DOCUMENTS from known sources, so ``load_document`` validates the URL first:

  * https only, default port only
  * no credentials in the URL (https://arxiv.org@evil.example/... is evil.example)
  * no IP literals (blocks 169.254.169.254, 10.x, ::1)
  * host on an allowlist (exact domain or a subdomain of it)
  * path ends in a document extension (.pdf .html .htm .txt .md), no '..' segments

A rejected URL comes back as a structured validation error (see D2.2), so the agent
knows to pick a different source instead of retrying.

Always offline (nothing is actually fetched). Run:  python constrained_tools.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

ALLOWED_DOMAINS = ("arxiv.org", "sec.gov", "who.int", "nature.com", "docs.example-research.org")
DOCUMENT_EXTENSIONS = (".pdf", ".html", ".htm", ".txt", ".md")
IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")

LOAD_DOCUMENT_TOOL = {
    "name": "load_document",
    "description": (
        "Load a document (PDF, HTML, plain text or Markdown) from an allowlisted research source "
        f"and return {{url, content_type, text}}. Input: url - https only, host in {list(ALLOWED_DOMAINS)} "
        "or a subdomain, path ending in .pdf/.html/.htm/.txt/.md. Rejected URLs return a validation "
        "error with the reason; choose another source rather than retrying the same URL. "
        "Not a general web fetcher - use web_search to find candidate documents first."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"url": {"type": "string", "description": "https URL of one document"}},
        "required": ["url"],
        "additionalProperties": False,
    },
}


def validate_document_url(url: str) -> str | None:
    """None if acceptable, otherwise the reason it is rejected."""
    if "/.." in url:
        return "path traversal ('..') is not allowed"
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return "not a valid URL"
    if parts.scheme != "https":
        return f"scheme '{parts.scheme}' not allowed; https only"
    if parts.username is not None or parts.password is not None:
        return "credentials in the URL are not allowed (the real host is after the '@')"
    host = (parts.hostname or "").lower()
    if not host:
        return "missing host"
    if IPV4.match(host) or ":" in host:
        return "IP-literal hosts are not allowed"
    if port not in (None, 443):
        return f"port {port} not allowed"
    if not any(host == d or host.endswith("." + d) for d in ALLOWED_DOMAINS):
        return f"host '{host}' is not on the document allowlist"
    if not parts.path.lower().endswith(DOCUMENT_EXTENSIONS):
        return f"path '{parts.path}' is not a document ({'/'.join(DOCUMENT_EXTENSIONS)})"
    return None


def load_document(url: str) -> tuple[dict[str, Any], bool]:
    """(payload, is_error). Fetching is simulated; validation is real."""
    reason = validate_document_url(url)
    if reason:
        return {
            "errorCategory": "validation",
            "isRetryable": False,
            "message": f"load_document rejected the URL: {reason}. Choose a different source.",
            "details": {"field": "url", "received": url, "reason": reason},
        }, True
    extension = Path(urlsplit(url).path).suffix.lower()
    content_type = {".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown"}.get(extension, "text/html")
    return {"url": url, "content_type": content_type, "text": f"<simulated contents of {url}>"}, False


def fetch_url(url: str) -> tuple[dict[str, Any], bool]:
    """The generic tool being replaced: no checks at all."""
    return {"url": url, "text": f"<whatever {url} returns>"}, False


# (url, should load_document accept it?)
CASES: list[tuple[str, bool]] = [
    ("https://arxiv.org/pdf/2401.12345v2.pdf", True),
    ("https://www.sec.gov/Archives/edgar/data/320193/aapl-10k.htm", True),
    ("https://www.nature.com/articles/s41586-024-07000-1.pdf", True),
    ("https://docs.example-research.org/reports/ai-in-film.md", True),
    ("http://arxiv.org/pdf/2401.12345v2.pdf", False),
    ("https://arxiv.org.evil.example/paper.pdf", False),
    ("https://arxiv.org@evil.example/paper.pdf", False),
    ("https://169.254.169.254/latest/meta-data/iam.txt", False),
    ("file:///etc/passwd", False),
    ("https://arxiv.org/abs/2401.12345", False),
    ("https://who.int/downloads/installer.exe", False),
    ("https://arxiv.org:8443/pdf/2401.12345v2.pdf", False),
    ("https://arxiv.org/pdf/../../admin/secrets.pdf", False),
]


def main() -> None:
    lab.banner("D2.3  Constrained tool: load_document instead of fetch_url")

    lab.section("Validation table")
    results = []
    for url, expected in CASES:
        payload, is_error = load_document(url)
        accepted = not is_error
        results.append((accepted == expected, accepted))
        verdict = "load " if accepted else "REJECT"
        reason = "" if accepted else payload["details"]["reason"]
        print(f"  {verdict} {url:<62} {reason}")

    lab.section("The same URLs through generic fetch_url")
    fetched = sum(1 for url, _ in CASES if not fetch_url(url)[1])
    print(f"  fetch_url would fetch {fetched}/{len(CASES)} of them, including the metadata endpoint and file://")

    lab.section("Error the agent sees for a rejected URL")
    lab.show("tool_result content", load_document("https://169.254.169.254/latest/meta-data/iam.txt")[0])

    lab.section("Checks")
    lab.check(all(ok for ok, _ in results), f"all {len(CASES)} URL cases behave as specified")
    lab.check(sum(1 for _, accepted in results if accepted) == 4, "only the 4 allowlisted https document URLs load")
    lab.check(fetched == len(CASES), "the generic fetch_url accepts every URL (why it was replaced)")
    lab.check(LOAD_DOCUMENT_TOOL["input_schema"]["additionalProperties"] is False, "load_document takes exactly one url argument")


if __name__ == "__main__":
    main()
