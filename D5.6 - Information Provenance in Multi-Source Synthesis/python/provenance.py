"""Provenance-preserving synthesis shared by the D5.6 demos.

Subagents return structured claim-source mappings:
    {claim_key, subtopic, content_type, claim, value, unit, evidence_excerpt,
     source_url, document_name, publication_date, data_collection_period, methodology}

The synthesis step never turns these into free text first. It:
    1. merges mappings by claim_key, then by value: the same claim from several sources
       becomes ONE finding with several citations;
    2. classifies each group: established (one value), temporal (values differ but the data
       periods do not overlap), or conflict (different values for the same period);
    3. completes the analysis with conflicts annotated (both values, both sources) and leaves
       reconciliation to the coordinator;
    4. renders each content type in its natural form: financial data as a table, news as
       prose, technical findings as a bulleted list, every claim with its citations.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "subagent_outputs.json").read_text(encoding="utf-8"))
TOPIC: str = FIXTURE["topic"]
REQUESTED: list[str] = FIXTURE["requested_subtopics"]


def all_claims() -> list[dict[str, Any]]:
    return [{**claim, "agent": sub["agent"]} for sub in FIXTURE["subagents"] for claim in sub["claims"]]


def source_index(claims: list[dict[str, Any]]) -> dict[str, str]:
    """Stable citation ids [S1], [S2] ... in order of first appearance."""
    index: dict[str, str] = {}
    for c in claims:
        index.setdefault(c["source_url"], f"S{len(index) + 1}")
    return index


# ---------------------------------------------------------------------------
# Merge and classify
# ---------------------------------------------------------------------------


def merge(claims: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for c in claims:
        group = groups.setdefault(c["claim_key"], {
            "claim_key": c["claim_key"], "subtopic": c["subtopic"], "content_type": c["content_type"], "variants": [],
        })
        variant = next((v for v in group["variants"] if v["value"] == c["value"]), None)
        if variant is None:
            variant = {"value": c["value"], "unit": c["unit"], "claim": c["claim"], "citations": []}
            group["variants"].append(variant)
        variant["citations"].append(c)  # keep the whole mapping: url, excerpt, dates, methodology
    return list(groups.values())


def periods(variant: dict[str, Any]) -> set[str]:
    return {c["data_collection_period"] for c in variant["citations"] if c["data_collection_period"]}


def classify(group: dict[str, Any]) -> str:
    variants = group["variants"]
    if len(variants) == 1:
        return "established"
    seen: set[str] = set()
    for v in variants:
        if not periods(v) or periods(v) & seen:
            return "conflict"  # same (or unknown) period, different values
        seen |= periods(v)
    return "temporal"  # every value comes from a different period: a change over time


def analyze(claims: list[dict[str, Any]]) -> dict[str, Any]:
    """Completes even when sources disagree: conflicts are annotated, never resolved or dropped here."""
    index = source_index(claims)
    groups = merge(claims)
    conflicts = []
    for group in groups:
        group["status"] = classify(group)
        if group["status"] == "conflict":
            conflicts.append({
                "claim_key": group["claim_key"],
                "status": "unresolved",
                "values": [
                    {
                        "value": v["value"], "unit": v["unit"],
                        "sources": [index[c["source_url"]] for c in v["citations"]],
                        "documents": [c["document_name"] for c in v["citations"]],
                        "periods": sorted(periods(v)),
                        "methodologies": [c["methodology"] for c in v["citations"]],
                    }
                    for v in group["variants"]
                ],
            })
    covered = {g["subtopic"] for g in groups}
    return {"groups": groups, "conflicts": conflicts, "gaps": [s for s in REQUESTED if s not in covered], "index": index}


# ---------------------------------------------------------------------------
# Coordinator reconciliation (a model call with a tool)
# ---------------------------------------------------------------------------

COORDINATOR_PROMPT = (
    "You are the research coordinator. The analysis step found conflicting values from credible sources. "
    "For each conflict call record_reconciliation. Do not pick a value arbitrarily: if the sources use "
    "different methodologies, report both with their methodology; if a source is clearly unreliable, say "
    "which to prefer and why; otherwise request a third source."
)
RECONCILE_TOOL: dict[str, Any] = {
    "name": "record_reconciliation",
    "description": "Record how the report should present one conflict.",
    "input_schema": {
        "type": "object",
        "properties": {
            "claim_key": {"type": "string"},
            "decision": {"type": "string", "enum": ["report_both_with_methodology", "prefer_source", "seek_third_source"]},
            "rationale": {"type": "string"},
        },
        "required": ["claim_key", "decision", "rationale"],
    },
}


def scripted_coordinator(params: dict[str, Any]) -> lab.Obj:
    if lab.tool_results(params):
        return lab.message(lab.text("Reconciliation recorded for every conflict."))
    conflicts = json.loads(lab.last_user_text(params).split("\n", 1)[1])
    calls = []
    for conflict in conflicts:
        methods = {m for v in conflict["values"] for m in v["methodologies"]}
        if len(methods) > 1:
            calls.append(lab.tool_use("record_reconciliation", {
                "claim_key": conflict["claim_key"], "decision": "report_both_with_methodology",
                "rationale": "Both sources are credible and cover the same period; the gap is explained by different inclusion rules.",
            }))
        else:
            calls.append(lab.tool_use("record_reconciliation", {
                "claim_key": conflict["claim_key"], "decision": "seek_third_source",
                "rationale": "Same methodology, different values: a third source is needed.",
            }))
    return lab.message(lab.text("Reviewing the annotated conflicts."), *calls)


def reconcile(client: Any, conflicts: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Coordinator loop: the model decides, the decisions come back as structured tool input."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": "Conflicts from the analysis step (JSON):\n" + json.dumps(conflicts, indent=2)}]
    decisions: dict[str, dict[str, Any]] = {}
    for _ in range(5):
        response = client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=COORDINATOR_PROMPT, tools=[RECONCILE_TOOL], messages=list(messages)
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return decisions
        results = []
        for block in lab.tool_uses(response):
            decisions[block.input["claim_key"]] = dict(block.input)
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": "recorded"})
        messages.append({"role": "user", "content": results})
    raise RuntimeError("coordinator did not finish")


# ---------------------------------------------------------------------------
# Naive summarization (the anti-pattern)
# ---------------------------------------------------------------------------

NAIVE_PROMPT = "Summarize these research findings into one concise paragraph."


def naive_input(claims: list[dict[str, Any]]) -> str:
    return "\n".join(f"- {c['claim']} (source: {c['document_name']}, {c['source_url']})" for c in claims)


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9%]+", text.lower()))


def same_topic(a: str, b: str) -> bool:
    shared, union = len(words(a) & words(b)), len(words(a) | words(b))
    return shared * 10 >= 4 * union  # word overlap (Jaccard) >= 0.4, in integer math


def scripted_summarizer(params: dict[str, Any]) -> lab.Obj:
    """Compresses to one sentence per topic: the first claim wins and attribution disappears."""
    kept: list[str] = []
    for line in lab.last_user_text(params).split("\n"):
        claim = line[2:].split(" (source:", 1)[0]
        if not any(same_topic(claim, k) for k in kept):
            kept.append(claim)
    return lab.message(lab.text(" ".join(kept)))


def summarize_naively(client: Any, claims: list[dict[str, Any]]) -> str:
    response = client.messages.create(
        model=lab.MODEL, max_tokens=16000, system=NAIVE_PROMPT, messages=[{"role": "user", "content": naive_input(claims)}]
    )
    return lab.text_of(response)


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    if lab.system_text(params).startswith(NAIVE_PROMPT):
        return scripted_summarizer(params)
    return scripted_coordinator(params)


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

LABELS = {"ai_music_funding_2026h1": "AI music startup funding"}


def cites(variant: dict[str, Any], index: dict[str, str]) -> str:
    return " ".join(f"[{index[c['source_url']]}]" for c in variant["citations"])


def render_report(analysis: dict[str, Any], decisions: dict[str, dict[str, Any]]) -> str:
    index, groups = analysis["index"], analysis["groups"]
    settled = [g for g in groups if g["status"] in ("established", "temporal")]
    lines = [f"# {TOPIC}", "", "## Well-established findings", "", "### Financial data", "",
             "| Finding | Value | Data period | Sources |", "|---|---|---|---|"]
    notes = []
    for g in (g for g in settled if g["content_type"] == "financial"):
        for v in g["variants"]:
            lines.append(f"| {v['claim']} | {v['value']} {v['unit']} | {', '.join(sorted(periods(v)))} | {cites(v, index)} |")
        if g["status"] == "temporal":
            by_period = "; ".join(f"{', '.join(sorted(periods(v)))}: {v['value']}" for v in g["variants"])
            notes.append(f"Temporal difference, not a contradiction: {g['claim_key']} changes with the data period ({by_period}).")
    lines += [""] + notes + ["", "### News", ""]
    news = [f"{v['claim'].rstrip('.')} {cites(v, index)}." for g in settled if g["content_type"] == "news" for v in g["variants"]]
    lines += [" ".join(news), "", "### Technical findings", ""]
    for g in (g for g in settled if g["content_type"] == "technical"):
        for v in g["variants"]:
            methods = "; ".join(c["methodology"] for c in v["citations"])
            lines.append(f"- {v['claim']} {cites(v, index)} (method: {methods})")
    lines += ["", "## Contested findings", ""]
    for conflict in analysis["conflicts"]:
        sides = " vs ".join(
            f"{v['value']} {v['unit']} per {' and '.join(v['documents'])} [{'] ['.join(v['sources'])}] ({'; '.join(v['methodologies'])})"
            for v in conflict["values"]
        )
        decision = decisions.get(conflict["claim_key"])
        verdict = f" Coordinator decision: {decision['decision']}. {decision['rationale']}" if decision else " Coordinator decision: pending."
        period = ", ".join(sorted({p for v in conflict["values"] for p in v["periods"]}))
        lines.append(f"- {LABELS.get(conflict['claim_key'], conflict['claim_key'])} ({period}): {sides}.{verdict}")
    lines += ["", "## Coverage gaps", ""]
    lines += [f"- {gap}: no subagent returned a sourced claim." for gap in analysis["gaps"]] or ["- none"]
    lines += ["", "## Sources", ""]
    by_url = {c["source_url"]: c for g in groups for v in g["variants"] for c in v["citations"]}
    for url, sid in index.items():
        c = by_url[url]
        lines.append(f"- [{sid}] {c['document_name']}. {url}. Published {c['publication_date']}; "
                     f"data {c['data_collection_period'] or 'n/a'}; method: {c['methodology']}.")
    return "\n".join(lines)


def section(report: str, title: str, level: str = "## ") -> str:
    """Lines of one section, up to the next heading of the same or a higher level."""
    out, inside = [], False
    for line in report.split("\n"):
        if line.startswith(level) or line.startswith("## ") or line.startswith("# "):
            inside = line == level + title
            continue
        if inside:
            out.append(line)
    return "\n".join(out)


def claim_units(report: str) -> list[str]:
    """Every rendered claim: table rows, bullets and prose sentences in the findings sections."""
    units = []
    for title in ("Well-established findings", "Contested findings"):
        for line in section(report, title).split("\n"):
            if line.startswith("| ") and not line.startswith("| Finding"):
                units.append(line)
            elif line.startswith("- "):
                units.append(line)
            elif line and not line.startswith(("#", "|", "Temporal difference")):
                units += [s for s in re.findall(r".+?(?:\.(?=\s|$)|$)", line) if s.strip()]
    return units
