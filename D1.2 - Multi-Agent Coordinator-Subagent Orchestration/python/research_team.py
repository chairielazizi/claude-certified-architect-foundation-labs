"""The D1.2 research team: role prompts, output contracts, and the offline stand-in model.

Hub-and-spoke: only the coordinator (coordinator.py) talks to these roles. A role is
defined by its system prompt and its output schema, nothing else. Each call it receives
is a brand-new conversation holding ONE user message (its task), so a subagent can only
know what the coordinator chose to write into that task.

Offline, `scripted_team` stands in for Claude. One function plays every role: it
dispatches on the system prompt, then decides from the task text it was given (it
cannot peek at anything else, just like the real API). The corpus is fictional and
exists only for the offline demo.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

# Subagent roles, in pipeline order. The coordinator picks a subset per query.
ROLES = ("web_search", "document_analysis", "synthesis", "report")

# The first line of every prompt is a role tag; the offline responder dispatches on it.
COORDINATOR_PROMPT = (
    "ROLE: research coordinator\n"
    "You plan work for a research team: web_search (news and web articles), document_analysis "
    "(research reports and academic papers), synthesis (combines findings and reports coverage gaps) "
    "and report (writes the final cited report).\n"
    "Match the machinery to the query. A single verifiable fact needs only web_search. A broad topic "
    "needs the full pipeline and a decomposition into subtopics that together cover every major sector "
    "of the topic, with no two subtopics covering the same ground.\n"
    "Return JSON with complexity, rationale, subagents and subtopics."
)

SUBAGENT_PROMPTS: dict[str, str] = {
    "web_search": (
        "ROLE: web_search subagent\n"
        "You research ONE assigned slice of a topic using news and web articles only. Stay inside your "
        "slice and source type; other agents cover the rest. For each finding give the claim, a short "
        "evidence excerpt, the source URL, the title and the publication date. Return JSON."
    ),
    "document_analysis": (
        "ROLE: document_analysis subagent\n"
        "You analyse research reports and academic papers for ONE assigned slice of a topic. For each "
        "finding give the claim, a short evidence excerpt, the document name, the page and the "
        "publication date. If nothing matches, return an empty list rather than stretching. Return JSON."
    ),
    "synthesis": (
        "ROLE: synthesis subagent\n"
        "Combine the findings you are given into key points per dimension, citing finding ids. Then judge "
        "coverage: every required dimension needs at least one web finding and one document finding. "
        "Report each gap as data: the dimension, what is missing, which subagent should fill it "
        "(web_search or document_analysis) and a targeted query. coverage_sufficient is true only when "
        "there are no gaps. Return JSON."
    ),
    "report": (
        "ROLE: report subagent\n"
        "Write the final research report from the synthesis and source list you are given. One line per "
        "dimension, cite sources inline as [F#], end with the source list. Use only what you are given."
    ),
}


def _obj(properties: dict[str, Any]) -> dict[str, Any]:
    """JSON-schema object with every property required and no extras (what structured outputs expect)."""
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


_STR = {"type": "string"}
_WEB_FINDING = _obj({"claim": _STR, "evidence": _STR, "source_url": _STR, "title": _STR, "publication_date": _STR})
_DOC_FINDING = _obj(
    {"claim": _STR, "evidence": _STR, "document_name": _STR, "page": {"type": "integer"}, "publication_date": _STR}
)

# Output contracts. In live mode they go to the API as output_config.format, so every JSON
# reply is schema-valid and the coordinator can route on fields instead of parsing prose.
OUTPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    "coordinator": _obj(
        {
            "complexity": {"type": "string", "enum": ["simple", "broad"]},
            "rationale": _STR,
            "subagents": {"type": "array", "items": {"type": "string", "enum": list(ROLES)}},
            "subtopics": {"type": "array", "items": _obj({"id": _STR, "focus": _STR})},
        }
    ),
    "web_search": _obj({"findings": {"type": "array", "items": _WEB_FINDING}}),
    "document_analysis": _obj({"findings": {"type": "array", "items": _DOC_FINDING}}),
    "synthesis": _obj(
        {
            "key_points": {
                "type": "array",
                "items": _obj({"dimension": _STR, "point": _STR, "finding_ids": {"type": "array", "items": _STR}}),
            },
            "coverage_gaps": {
                "type": "array",
                "items": _obj(
                    {
                        "dimension": _STR,
                        "missing": _STR,
                        "target_role": {"type": "string", "enum": ["web_search", "document_analysis"]},
                        "suggested_query": _STR,
                    }
                ),
            },
            "coverage_sufficient": {"type": "boolean"},
        }
    ),
}


def json_output(role: str) -> dict[str, Any]:
    return {"format": {"type": "json_schema", "schema": OUTPUT_SCHEMAS[role]}}


def tag(text: str, name: str) -> str:
    """Contents of <name>...</name> in a task prompt ("" if absent)."""
    match = re.search(rf"<{name}>\s*(.*?)\s*</{name}>", text, re.S)
    return match.group(1) if match else ""


# ---------------------------------------------------------------------------
# Fictional corpus (offline only)
# ---------------------------------------------------------------------------

WEB_CORPUS: list[dict[str, Any]] = [
    {
        "keywords": ["ai act"],
        "claim": "The EU AI Act entered into force on 1 August 2024; its obligations phase in over the following years.",
        "evidence": "The regulation entered into force on 1 August 2024 ...",
        "source_url": "https://example.org/eu-ai-act-timeline",
        "title": "EU AI Act: the implementation timeline",
        "publication_date": "2024-08-01",
    },
    {
        "keywords": ["visual art", "digital art", "graphic design", "photography", "illustration"],
        "claim": "Freelance illustrators and stock photographers report fewer commissions as marketing teams adopt image generators.",
        "evidence": "'My stock-style work dried up within a year,' one illustrator said ...",
        "source_url": "https://example.org/news/illustrators-and-image-generators",
        "title": "Illustrators feel the squeeze from image generators",
        "publication_date": "2026-02-11",
    },
    {
        "keywords": ["music"],
        "claim": "Record labels are licensing catalogues to AI music start-ups while suing unlicensed generators.",
        "evidence": "The licensing deal follows two lawsuits filed earlier this year ...",
        "source_url": "https://example.org/news/labels-license-ai-music",
        "title": "Labels split strategy on AI music",
        "publication_date": "2026-04-02",
    },
    {
        "keywords": ["writing", "publishing"],
        "claim": "Publishers report a surge in AI-assisted manuscript submissions and are adding disclosure rules.",
        "evidence": "Submissions doubled; the new policy requires authors to disclose AI assistance ...",
        "source_url": "https://example.org/news/publishers-ai-disclosure",
        "title": "Publishers add AI disclosure requirements",
        "publication_date": "2026-01-20",
    },
    {
        "keywords": ["film", "video"],
        "claim": "Studios use generative tools for pre-visualisation, and union agreements now regulate digital replicas of performers.",
        "evidence": "The agreement requires consent and compensation for any digital replica ...",
        "source_url": "https://example.org/news/studios-previs-digital-replicas",
        "title": "Generative previs goes mainstream on film sets",
        "publication_date": "2026-05-18",
    },
]

DOC_CORPUS: list[dict[str, Any]] = [
    {
        "keywords": ["visual art", "digital art", "graphic design", "photography"],
        "claim": "38% of surveyed illustrators lost at least one recurring client to AI tools.",
        "evidence": "Table 4: client loss by discipline ...",
        "document_name": "Creative Labour Survey 2026",
        "page": 14,
        "publication_date": "2026-03-01",
    },
    {
        "keywords": ["music"],
        "claim": "Licensed AI-training deals became a growing share of music publishing income.",
        "evidence": "Section 2.3: new revenue lines ...",
        "document_name": "Music Rights Review 2026",
        "page": 7,
        "publication_date": "2026-02-15",
    },
    {
        "keywords": ["writing", "publishing"],
        "claim": "Translation and copy-editing are the publishing roles most exposed to automation.",
        "evidence": "Figure 9: exposure index by role ...",
        "document_name": "Publishing Futures Report",
        "page": 22,
        "publication_date": "2025-11-30",
    },
    {
        # Indexed under VFX terminology only, so a generic "film" query misses it. The
        # refinement loop exists for exactly this: a targeted follow-up query finds it.
        "keywords": ["visual effects", "vfx", "animation"],
        "claim": "VFX houses are automating rotoscoping and clean-up, shifting junior roles toward supervision.",
        "evidence": "Chapter 3: task automation in post-production ...",
        "document_name": "Screen Industries VFX Workforce Study",
        "page": 31,
        "publication_date": "2026-06-01",
    },
]

# Follow-up queries the synthesis agent proposes for a gap (it "knows" the field's vocabulary).
TARGETED_QUERIES = {
    ("film", "document_analysis"): "AI in visual effects (VFX) and animation: workforce studies",
}

# Subtopics a well-prompted coordinator produces for the broad demo topic.
CREATIVE_SUBTOPICS = [
    {"id": "st1", "focus": "AI in visual arts: digital art, graphic design and photography"},
    {"id": "st2", "focus": "AI in music composition and production"},
    {"id": "st3", "focus": "AI in writing and publishing"},
    {"id": "st4", "focus": "AI in film and video production"},
]


# ---------------------------------------------------------------------------
# Offline stand-in for Claude, one handler per role
# ---------------------------------------------------------------------------


def _reply(payload: Any) -> lab.Obj:
    return lab.message(lab.text(payload if isinstance(payload, str) else json.dumps(payload)))


def is_factual_question(query: str) -> bool:
    return bool(re.match(r"\s*(when|what year|who|how many)\b", query, re.I)) and len(query.split()) <= 16


def _plan(params: dict[str, Any]) -> lab.Obj:
    query = params["messages"][0]["content"]
    if is_factual_question(query):
        return _reply(
            {
                "complexity": "simple",
                "rationale": "One verifiable fact: a single targeted search answers it; synthesis and a report add latency, not coverage.",
                "subagents": ["web_search"],
                "subtopics": [{"id": "q1", "focus": query}],
            }
        )
    subtopics = CREATIVE_SUBTOPICS if "creative industries" in query.lower() else [
        {"id": "st1", "focus": f"{query}: current evidence"},
        {"id": "st2", "focus": f"{query}: open questions"},
    ]
    return _reply(
        {
            "complexity": "broad",
            "rationale": "Broad topic spanning several sectors: partition by sector and source type, then synthesise and report.",
            "subagents": list(ROLES),
            "subtopics": subtopics,
        }
    )


def _search(corpus: list[dict[str, Any]], fields: tuple[str, ...]):
    def handle(params: dict[str, Any]) -> lab.Obj:
        focus = tag(lab.last_user_text(params), "slice").lower()
        hits = [doc for doc in corpus if any(k in focus for k in doc["keywords"])]
        return _reply({"findings": [{f: doc[f] for f in fields} for doc in hits]})

    return handle


def _synthesize(params: dict[str, Any]) -> lab.Obj:
    task = lab.last_user_text(params)
    required = json.loads(tag(task, "required_dimensions") or "[]")
    findings = json.loads(tag(task, "findings") or "[]")
    key_points, gaps = [], []
    for dim in required:
        mine = [f for f in findings if f["dimension"] == dim]
        if mine:
            key_points.append(
                {"dimension": dim, "point": " ".join(f["claim"] for f in mine), "finding_ids": [f["id"] for f in mine]}
            )
        for source_type, role, label in (("web", "web_search", "web"), ("documents", "document_analysis", "document")):
            if not any(f["source_type"] == source_type for f in mine):
                default = f"AI in {dim.replace('_', ' ')}: {'news coverage' if role == 'web_search' else 'reports and papers'}"
                gaps.append(
                    {
                        "dimension": dim,
                        "missing": f"no {label} evidence",
                        "target_role": role,
                        "suggested_query": TARGETED_QUERIES.get((dim, role), default),
                    }
                )
    return _reply({"key_points": key_points, "coverage_gaps": gaps, "coverage_sufficient": not gaps})


def _report(params: dict[str, Any]) -> lab.Obj:
    task = lab.last_user_text(params)
    synthesis = json.loads(tag(task, "synthesis"))
    sources = json.loads(tag(task, "sources"))
    lines = [f"Research report: {tag(task, 'topic')}"]
    for point in synthesis["key_points"]:
        cites = "".join(f"[{i}]" for i in point["finding_ids"])
        lines.append(f"- {point['dimension']}: {point['point']} {cites}")
    lines.append("Sources:")
    lines += [f"  [{s['id']}] {s['citation']}" for s in sources]
    return _reply("\n".join(lines))


_HANDLERS = {
    COORDINATOR_PROMPT.splitlines()[0]: _plan,
    SUBAGENT_PROMPTS["web_search"].splitlines()[0]: _search(
        WEB_CORPUS, ("claim", "evidence", "source_url", "title", "publication_date")
    ),
    SUBAGENT_PROMPTS["document_analysis"].splitlines()[0]: _search(
        DOC_CORPUS, ("claim", "evidence", "document_name", "page", "publication_date")
    ),
    SUBAGENT_PROMPTS["synthesis"].splitlines()[0]: _synthesize,
    SUBAGENT_PROMPTS["report"].splitlines()[0]: _report,
}


def role_of(params: dict[str, Any]) -> str:
    """Which role a request is addressed to (from the role tag on its system prompt)."""
    first = lab.system_text(params).splitlines()[0]
    return first.removeprefix("ROLE: ").removesuffix(" subagent").replace("research ", "")


def scripted_team(params: dict[str, Any]) -> lab.Obj:
    """Offline stand-in for every role: dispatch on the system prompt's role tag."""
    handler = _HANDLERS.get(lab.system_text(params).splitlines()[0])
    if handler is None:
        raise RuntimeError("scripted_team: unknown role")
    return handler(params)
