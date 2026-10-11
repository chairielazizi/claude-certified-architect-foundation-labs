"""Static checks for tool interfaces and system prompts (D2.1).

Three reviews you can run in CI before a toolset ever reaches the model:

* ``lint_tool``            - does each description carry the parts the model needs to
                             choose correctly (inputs, outputs, examples, edge cases,
                             when-to-use, when-NOT-to-use naming a sibling tool)?
* ``find_overlaps``        - token Jaccard similarity between descriptions; near-identical
                             pairs (analyze_content vs analyze_document) misroute.
* ``lint_system_prompt``   - keyword-triggered tool instructions ("whenever the user
                             mentions an order, call get_customer") that override good
                             descriptions and create unintended associations.

The tokenizer here is also what the offline selector in selection_harness.py "reads",
so both the linter and the stand-in model work from the same evidence.
"""

from __future__ import annotations

import re
from itertools import combinations
from typing import Any

# Identifier shapes become tokens of their own, so "#12345" in a request can match an
# "accepts #48213" input-format sentence in a description. Input formats are evidence.
SHAPES: list[tuple[str, str]] = [
    (r"https?://\S+", "@url"),
    (r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", "@email"),
    (r"\bORD-\d+", "@order_id"),
    (r"\bC-\d+", "@customer_id"),
    (r"#\d+", "@hash_number"),
]

STOPWORDS = set(
    """an the and or of to in on for from with by at as is are was be been it its this that these
    those my me you your we our us do does did can could would should will what which who whom
    whose when where how any all every some one get give please here there into about than then them
    they their has have had just also only out up so if yet really still am""".split()
)

# A sentence containing one of these is a boundary ("Does not ...", "use X instead"):
# its words are evidence AGAINST choosing the tool, not for it.
NEGATION = re.compile(r"\b(not|instead|never)\b|n't\b", re.I)


def stem(word: str) -> str:
    """Crude suffix stripping so 'shipped'/'shipping' and 'sources'/'source' meet."""
    if len(word) > 5 and word.endswith("ing"):
        return word[:-3]
    if len(word) > 4 and word.endswith("ed"):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


# A few synonyms stand in for the semantic matching a real model does ("paper" is a
# document). Kept tiny on purpose: everything else must come from the description.
SYNONYMS = {"paper": "document", "report": "document", "pdf": "document", "filing": "document", "article": "document"}


def tokens(text: str) -> set[str]:
    """Content tokens of a text: identifier shapes + stemmed words minus stopwords."""
    found: set[str] = set()
    for pattern, shape in SHAPES:
        if re.search(pattern, text, re.I):
            # Any id-like value is also generic "identifier" evidence: a tool documented
            # only as taking an "Identifier" matches every id (sample Q2's ambiguity).
            found.update((shape, "identifier"))
            text = re.sub(pattern, " ", text, flags=re.I)
    for word in re.findall(r"[a-z][a-z0-9_]+", text.lower()):
        if word not in STOPWORDS:
            word = stem(word)
            found.add(SYNONYMS.get(word, word))
    return found


def sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def name_tokens(name: str) -> set[str]:
    return {stem(part) for part in name.lower().split("_") if part and part not in STOPWORDS}


def evidence(tool: dict[str, Any]) -> tuple[set[str], set[str]]:
    """(positive, negative) evidence tokens a reader gets from a tool definition."""
    positive = name_tokens(tool["name"])
    negative: set[str] = set()
    texts = [tool.get("description", "")]
    texts += [p.get("description", "") for p in tool.get("input_schema", {}).get("properties", {}).values()]
    for text in texts:
        for sentence in sentences(text):
            (negative if NEGATION.search(sentence) else positive).update(tokens(sentence))
    return positive, negative


def score_tools(tools: list[dict[str, Any]], request: str) -> list[tuple[str, int]]:
    """Score = request tokens a tool's description supports minus those its boundaries reject."""
    req = tokens(request)
    scored = []
    for tool in tools:
        positive, negative = evidence(tool)
        scored.append((tool["name"], len(req & positive) - len(req & negative)))
    return scored


# ---------------------------------------------------------------------------
# Description linter
# ---------------------------------------------------------------------------

MIN_DESCRIPTION_CHARS = 200

DESCRIPTION_CHECKS: list[tuple[str, str]] = [
    ("states what it returns", r"\breturns?\b"),
    ("documents the input format", r"\b(input|accepts|format|such as)\b"),
    ("gives example queries", r"\bexamples?\b"),
    ("says when to use it", r"\buse (this|it) (when|for|to|only)\b"),
    ("says when NOT to use it", r"\b(does not|do not|not for|instead)\b"),
    ("covers an edge case", r"\bedge cases?\b|\bif no\b|\bwhen no\b"),
]

VAGUE_VERBS = {"analyze", "process", "handle", "manage", "do", "run"}
VAGUE_NOUNS = {"content", "data", "document", "item", "info", "information", "thing"}


def lint_tool(tool: dict[str, Any], siblings: list[str]) -> list[str]:
    """Findings for one tool definition (empty list = clean)."""
    desc = tool.get("description", "")
    findings: list[str] = []
    if len(desc) < MIN_DESCRIPTION_CHARS:
        findings.append(f"description is {len(desc)} chars (< {MIN_DESCRIPTION_CHARS}); too little to differentiate")
    for label, pattern in DESCRIPTION_CHECKS:
        if not re.search(pattern, desc, re.I):
            findings.append(f"missing: {label}")
    others = [s for s in siblings if s != tool["name"]]
    if others and not any(other in desc for other in others):
        findings.append("names no sibling tool (no 'use X instead' boundary)")
    parts = tool["name"].split("_")
    if parts[0] in VAGUE_VERBS and parts[-1] in VAGUE_NOUNS:
        findings.append(f"generic name '{tool['name']}' - rename or split by purpose")
    schema = tool.get("input_schema", {})
    if "required" not in schema:
        findings.append("input_schema has no 'required' list (undefined input contract)")
    undocumented = [k for k, v in schema.get("properties", {}).items() if len(v.get("description", "")) < 12]
    if undocumented:
        findings.append(f"parameters without a useful description: {undocumented}")
    return findings


def lint_toolset(tools: list[dict[str, Any]]) -> dict[str, list[str]]:
    names = [t["name"] for t in tools]
    return {t["name"]: lint_tool(t, names) for t in tools}


# ---------------------------------------------------------------------------
# Overlap detector
# ---------------------------------------------------------------------------

OVERLAP_THRESHOLD = 0.5


def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a | b else 0.0


def find_overlaps(tools: list[dict[str, Any]], threshold: float = OVERLAP_THRESHOLD) -> list[tuple[str, str, float]]:
    """Pairs of tools whose descriptions are near-identical (likely to be confused)."""
    pairs = []
    for t1, t2 in combinations(tools, 2):
        score = jaccard(tokens(t1["description"]), tokens(t2["description"]))
        pairs.append((t1["name"], t2["name"], round(score, 2)))
    return sorted((p for p in pairs if p[2] >= threshold), key=lambda p: -p[2])


def max_similarity(tools: list[dict[str, Any]]) -> float:
    return max(
        (jaccard(tokens(a["description"]), tokens(b["description"])) for a, b in combinations(tools, 2)),
        default=0.0,
    )


# ---------------------------------------------------------------------------
# System-prompt keyword linter
# ---------------------------------------------------------------------------

# "<trigger on a keyword> ... <call|use> <tool>" phrasings. Each captures (keyword, tool).
KEYWORD_RULES = [
    r"whenever (?:the )?(?:user|customer|message|request)s? (?:mentions?|says|asks about|contains|uses)"
    r" (?:the word )?(?:an? |the )?['\"]?(\w+)['\"]?[^.]*?\b(?:call|use|run|invoke) (\w+)",
    r"if (?:a|the|any) (?:user )?(?:message|request|question) (?:contains|mentions|includes|says)"
    r" (?:the word )?['\"]?(\w+)['\"]?[^.]*?\b(?:call|use|run|invoke) (\w+)",
    r"for anything (?:about|related to|involving|mentioning) (?:an? |the )?['\"]?(\w+)['\"]?[^.]*?\b(?:call|use) (\w+)",
]


def keyword_rules(system_prompt: str) -> list[tuple[str, str]]:
    """(keyword, tool) associations the prompt creates."""
    found = []
    for rule in KEYWORD_RULES:
        for match in re.finditer(rule, system_prompt, re.I):
            found.append((match.group(1).lower(), match.group(2)))
    return found


def lint_system_prompt(system_prompt: str, tool_names: list[str]) -> list[str]:
    findings = []
    for keyword, tool in keyword_rules(system_prompt):
        msg = (
            f"keyword trigger '{keyword}' -> {tool}: any message containing '{keyword}' is pushed to "
            f"{tool}, overriding the tool descriptions; state the intent/condition instead"
        )
        if tool not in tool_names:
            msg += f" (and {tool} is not in the toolset)"
        findings.append(msg)
    return findings
