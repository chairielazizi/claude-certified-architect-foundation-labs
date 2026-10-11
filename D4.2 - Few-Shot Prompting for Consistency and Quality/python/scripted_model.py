"""Offline stand-ins for Claude in D4.2. Behaviour is driven by the examples in the prompt.

review_model:
  * zero-shot  -> judgment is "anything that looks risky", and the output format drifts from
                 snippet to snippet (prose, other key names, other severity words), which is
                 the failure mode the exam describes for instructions-only prompts
  * few-shot   -> copies the keys and severity words from the first example's output; if an
                 example shows an acceptable-looking pattern being NOT flagged, it applies
                 that judgment ("is the failure still visible?") instead of flagging on sight

extraction_model: a literal-minded reader unless the examples demonstrate otherwise.
  * an example with a References list       -> reads bibliography / notes entries
  * an example with methodology but no Methods heading -> finds methods in the narrative
  * an example with approximate measurements or a "Name's YEAR" citation -> reads informal ones
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from fewshot_prompts import load_json  # noqa: E402

SNIPPETS: list[dict[str, Any]] = load_json("review_snippets.json")["snippets"]

# ---------------------------------------------------------------------------
# Review model
# ---------------------------------------------------------------------------

_SEVERITY_WORDS = {"low": "Minor", "medium": "Moderate", "high": "Major", "critical": "Blocker"}


def _example_outputs(system: str) -> list[Any]:
    return [json.loads(o) for o in re.findall(r"<output>(.*?)</output>", system, flags=re.DOTALL)]


def _zero_shot_text(index: int, finding: dict[str, str]) -> str:
    """Instructions alone: the substance is there, the shape is not stable."""
    loc, issue, sev, fix = finding["location"], finding["issue"], finding["severity"], finding["suggested_fix"]
    variant = index % 5
    if variant == 0:
        return json.dumps([{**finding, "severity": _SEVERITY_WORDS[sev]}])
    if variant == 1:
        return f"I found one problem in {loc}: {issue} I would rate this {sev} severity. To fix it: {fix}"
    if variant == 2:
        file, line = loc.rsplit(":", 1)
        return json.dumps({"file": file, "line": int(line), "problem": issue, "level": sev})
    if variant == 3:
        return f"- **{loc}** ({sev}): {issue}\n  - Fix: {fix}"
    return json.dumps([finding])


def review_model(params: dict[str, Any]) -> lab.Obj:
    system = lab.system_text(params)
    user = lab.last_user_text(params)
    file = re.search(r'<code file="([^"]+)">', user).group(1)  # type: ignore[union-attr]
    index, snippet = next((i, s) for i, s in enumerate(SNIPPETS) if s["file"] == file)

    outputs = _example_outputs(system)
    few_shot = len(outputs) >= 2
    learned_acceptable = any(o == [] for o in outputs)  # an example showed "looks risky, NOT an issue"

    if snippet["kind"] == "genuine":
        finding: dict[str, str] | None = dict(snippet["truth"])
    elif few_shot and learned_acceptable:
        finding = None  # same judgment as the acceptable example: nothing is swallowed
    else:
        finding = {
            "location": f"{snippet['file']}:{snippet['suspicious_line']}",
            "issue": f"Risky pattern: {snippet['looks_suspicious_because']}.",
            "severity": "medium",
            "suggested_fix": "Narrow or remove the exception handler.",
        }

    if not few_shot:
        text = _zero_shot_text(index, finding) if finding else "[]"
        return lab.message(lab.text(text))

    # Few-shot: mirror the example format key-for-key.
    keys = next(list(o[0].keys()) for o in outputs if isinstance(o, list) and o)
    text = json.dumps([{k: finding[k] for k in keys}]) if finding else "[]"
    return lab.message(lab.text(text))


# ---------------------------------------------------------------------------
# Extraction model
# ---------------------------------------------------------------------------

_STUDY_VERBS = r"\b(ran|surveyed|interviewed|measured|weighed|sampled|recruited|mixed|steeped|compared|matched)\b"
_INFORMAL = {
    "a couple of": (2.0, None),
    "about half a": (0.5, None),
    "half a": (0.5, None),
    "roughly a dozen": (12.0, None),
    "a dozen": (12.0, None),
    "a handful of": (1.0, "handful"),
    "a pinch of": (1.0, "pinch"),
}
_UNITS = {"cup": "cup", "cups": "cup", "gram": "g", "grams": "g", "teaspoon": "tsp", "teaspoons": "tsp"}


def _skills(system: str) -> dict[str, bool]:
    """What the examples in the prompt demonstrate."""
    docs = re.findall(r"<document>\n(.*?)\n</document>", system, flags=re.DOTALL)
    outs = [json.loads(o) for o in re.findall(r"<output>(.*?)</output>", system, flags=re.DOTALL)]
    return {
        "bibliography": any("\nReferences\n" in d for d in docs),
        "embedded_methods": any(o.get("methodology") and "Methods:" not in d for d, o in zip(docs, outs)),
        "informal": any(m.get("approximate") for o in outs for m in o.get("measurements", [])),
        "narrative_citations": any(re.search(r"[A-Z][a-z]+'s \d{4}", d) for d in docs),
    }


def _extract(text: str, skills: dict[str, bool]) -> dict[str, Any]:
    title = re.search(r"^Title: (.+)$", text, flags=re.MULTILINE).group(1)  # type: ignore[union-attr]
    parts = re.split(r"\n(?:References|Notes)\n", text, maxsplit=1)
    body = parts[0]
    bibliography = parts[1] if len(parts) > 1 else ""

    # methodology: literal reader only trusts a "Methods:" heading
    heading = re.search(r"^Methods: (.+)$", body, flags=re.MULTILINE)
    methodology = heading.group(1) if heading else None
    if methodology is None and skills["embedded_methods"]:
        sentences = re.split(r"(?<=[.!?])\s+", body.split("\n", 1)[1])
        hit = next((s for s in sentences if re.search(_STUDY_VERBS, s)), None)
        methodology = re.sub(r"^\w+: ", "", hit.strip()) if hit else None

    citations = [f"{a} ({y})" for a, y in re.findall(r"\(([A-Z][A-Za-z]+(?: et al\.)?), (\d{4})\)", body)]
    if skills["narrative_citations"]:
        citations += [f"{a} ({y})" for a, y in re.findall(r"\b([A-Z][a-z]+)'s (\d{4})\b", body)]
    if skills["bibliography"] and bibliography:
        citations += re.findall(r"^(?:\d+\.|\^\d+)\s+(.+)$", bibliography, flags=re.MULTILINE)

    found: list[tuple[int, dict[str, Any]]] = []
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*(mL|g|kg|L)\b(?: of ([a-z]+(?: [a-z]+)?))?", body):
        found.append((m.start(), {"quantity": float(m.group(1)), "unit": m.group(2), "approximate": False, "original_text": m.group(0)}))
    if skills["informal"]:
        phrases = "|".join(sorted(_INFORMAL, key=len, reverse=True))
        pattern = rf"({phrases})\s*(cups?|grams?|teaspoons?)?(?: of)? ([a-z]+)"
        for m in re.finditer(pattern, body):
            qty, phrase_unit = _INFORMAL[m.group(1)]
            unit = _UNITS.get(m.group(2) or "", phrase_unit or "unit")
            found.append((m.start(), {"quantity": qty, "unit": unit, "approximate": True, "original_text": m.group(0)}))
    measurements = [m for _, m in sorted(found, key=lambda pair: pair[0])]

    return {"title": title, "methodology": methodology, "citations": citations, "measurements": measurements}


def extraction_model(params: dict[str, Any]) -> lab.Obj:
    system = lab.system_text(params)
    document = re.search(r"<document>\n(.*)\n</document>", lab.last_user_text(params), flags=re.DOTALL).group(1)  # type: ignore[union-attr]
    return lab.message(lab.text(json.dumps(_extract(document, _skills(system)))))
