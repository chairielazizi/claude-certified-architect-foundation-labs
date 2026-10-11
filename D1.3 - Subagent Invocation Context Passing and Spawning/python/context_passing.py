"""D1.3 - Passing context to a subagent: complete structured findings vs a prose summary.

A subagent starts with an EMPTY context. The synthesizer can only cite what its prompt
contains, so the coordinator passes the complete prior findings, with content and source
metadata in separate fields:

    {"finding_id": "D2", "agent": "doc-analyst",
     "content":  {"claim": "...", "evidence": "..."},
     "metadata": {"source_url": null, "document_name": "...", "page": 31, "publication_date": "2026-06-01"}}

The anti-pattern is a prose recap ("earlier research found that ..."): every claim survives,
every source is gone, and two conflicting figures can no longer be told apart.

Run:  python context_passing.py          (offline)
      python context_passing.py --live   (the synthesizer is a real messages.create call)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from agent_definitions import AGENT_SPECS, TOPIC  # noqa: E402

# What web-researcher and doc-analyst returned earlier in the session (fictional data).
# W2 and D2 disagree on purpose: only attribution lets a reader weigh them.
FINDINGS: list[dict[str, Any]] = [
    {
        "finding_id": "W1",
        "agent": "web-researcher",
        "content": {
            "claim": "Two major record labels signed licensing deals with AI music start-ups in 2026.",
            "evidence": "The agreements license back catalogues for model training ...",
        },
        "metadata": {
            "source_url": "https://example.org/news/labels-license-ai-music",
            "document_name": None,
            "page": None,
            "publication_date": "2026-04-02",
        },
    },
    {
        "finding_id": "D1",
        "agent": "doc-analyst",
        "content": {
            "claim": "Licensed AI-training deals made up 6% of music publishing income in 2025.",
            "evidence": "... up from under 1% in 2023.",
        },
        "metadata": {"source_url": None, "document_name": "Music Rights Review 2026", "page": 7, "publication_date": "2026-02-15"},
    },
    {
        "finding_id": "W2",
        "agent": "web-researcher",
        "content": {
            "claim": "A trade-press survey found 40% of VFX studios use generative AI in production.",
            "evidence": "Four in ten studios told the survey they use generative tools ...",
        },
        "metadata": {
            "source_url": "https://example.org/news/vfx-genai-survey",
            "document_name": None,
            "page": None,
            "publication_date": "2026-05-30",
        },
    },
    {
        "finding_id": "D2",
        "agent": "doc-analyst",
        "content": {
            "claim": "28% of surveyed VFX studios report using generative AI tools in production work.",
            "evidence": "Rotoscoping and clean-up are the most automated tasks.",
        },
        "metadata": {
            "source_url": None,
            "document_name": "Screen Industries VFX Workforce Study",
            "page": 31,
            "publication_date": "2026-06-01",
        },
    },
]


def source_of(finding: dict[str, Any]) -> str:
    meta = finding["metadata"]
    if meta["source_url"]:
        return f"{meta['source_url']} ({meta['publication_date']})"
    return f"{meta['document_name']}, p. {meta['page']} ({meta['publication_date']})"


def prose_handoff(topic: str, findings: list[dict[str, Any]]) -> str:
    """BAD: the coordinator 'helpfully' recaps earlier work in prose."""
    recap = "; ".join(f["content"]["claim"].rstrip(".") for f in findings)
    return f"Write a research briefing on: {topic}\nBackground from earlier research: {recap}."


def structured_handoff(topic: str, findings: list[dict[str, Any]]) -> str:
    """GOOD: the complete findings, content separated from metadata, plus how to use them."""
    records = "[\n" + ",\n".join(json.dumps(f) for f in findings) + "\n]"
    return (
        f"Write a research briefing on: {topic}\n\n"
        "You have no other context. The findings below are the complete output of the web-researcher and "
        "doc-analyst subagents. Each one separates content (claim, evidence) from metadata (source_url, "
        "document_name, page, publication_date).\n"
        "Cite every claim with its finding_id and source. If two findings disagree, present both values "
        "with their sources.\n\n"
        f"<findings>\n{records}\n</findings>"
    )


def findings_in(prompt: str) -> list[dict[str, Any]]:
    block = re.search(r"<findings>\s*(.*?)\s*</findings>", prompt, re.S)
    return json.loads(block.group(1)) if block else []


def attribution_report(prompt: str, findings: list[dict[str, Any]]) -> dict[str, dict[str, bool]]:
    """Per original finding: is its claim in the prompt, and is it still tied to its own source?"""
    passed = {f["content"]["claim"]: f["metadata"] for f in findings_in(prompt)}
    return {
        f["finding_id"]: {
            "claim_present": f["content"]["claim"].rstrip(".") in prompt,
            "source_attached": passed.get(f["content"]["claim"]) == f["metadata"],
        }
        for f in findings
    }


def scripted_synthesizer(params: dict[str, Any]) -> lab.Obj:
    """Offline synthesizer: it can only cite what its prompt gives it, same as the real subagent."""
    prompt = lab.last_user_text(params)
    passed = findings_in(prompt)
    if not passed:
        recap = prompt.split("Background from earlier research:", 1)[-1].strip().rstrip(".")
        lines = ["Briefing (from background notes; no sources were provided):"]
        lines += [f"- {sentence}." for sentence in recap.split("; ")]
    else:
        lines = ["Briefing:"] + [f"- {f['content']['claim']} [{f['finding_id']}: {source_of(f)}]" for f in passed]
    return lab.message(lab.text("\n".join(lines)))


def run_synthesizer(client: Any, prompt: str) -> str:
    """The synthesizer as a subagent: its own system prompt and a fresh one-message conversation."""
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=AGENT_SPECS["synthesizer"]["prompt"],
        messages=[{"role": "user", "content": prompt}],
    )
    return lab.text_of(response)


def main() -> None:
    lab.banner("D1.3  Context passing: complete, structured findings for the synthesizer")

    lab.section("Prior findings (returned earlier by web-researcher and doc-analyst)")
    for f in FINDINGS:
        print(f"  {f['finding_id']} {f['agent']:<14} {f['content']['claim']}")
        print(f"     source: {source_of(f)}")

    bad, good = prose_handoff(TOPIC, FINDINGS), structured_handoff(TOPIC, FINDINGS)

    lab.section("BAD: prose summary in the synthesizer's prompt")
    print(bad)
    bad_report = attribution_report(bad, FINDINGS)
    lab.check(all(r["claim_present"] for r in bad_report.values()), "every claim made it into the prose recap ...")
    lab.check(not any(r["source_attached"] for r in bad_report.values()), "... but 0 of 4 claims are still tied to a source")

    lab.section("GOOD: complete findings as JSON, content separate from metadata")
    print(good)
    good_report = attribution_report(good, FINDINGS)
    passed = findings_in(good)
    metadata_keys = {"source_url", "document_name", "page", "publication_date"}
    lab.check(all(r["claim_present"] and r["source_attached"] for r in good_report.values()), "4 of 4 claims are still tied to their own source")
    lab.check(all({"content", "metadata"} <= set(f) and set(f["metadata"]) == metadata_keys for f in passed),
              "every finding keeps content (claim, evidence) and metadata in separate fields")
    lab.check(passed == FINDINGS, "the COMPLETE findings were passed; nothing was summarised away")

    lab.section("What the synthesizer subagent writes from each prompt")
    client = lab.get_client(scripted_synthesizer)
    outputs = {}
    for label, prompt in (("prose prompt", bad), ("structured prompt", good)):
        outputs[label] = run_synthesizer(client, prompt)
        print(f"[{label}]\n  " + outputs[label].replace("\n", "\n  "))

    if not lab.is_live():
        sources = [f["metadata"]["source_url"] or f["metadata"]["document_name"] for f in FINDINGS]
        lab.check(not any(s in outputs["prose prompt"] for s in sources), "from the prose prompt the synthesizer can cite nothing")
        lab.check(all(s in outputs["structured prompt"] for s in sources), "from the structured prompt every claim in the briefing is cited")
        lines = outputs["structured prompt"].splitlines()
        line_40 = next(line for line in lines if "40%" in line)
        line_28 = next(line for line in lines if "28%" in line)
        lab.check("vfx-genai-survey" in line_40 and "VFX Workforce Study" in line_28,
                  "the conflicting VFX figures (40% vs 28%) stay side by side, each with its own source")


if __name__ == "__main__":
    main()
