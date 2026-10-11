"""D5.6 - Naive summarization loses attribution; merged claim-source mappings keep it.

Three subagents return 12 structured claim-source mappings from 12 sources.

    A  naive       "summarize these findings into one paragraph" -> fluent text, no sources,
                   one value picked where sources disagree, the newer figure dropped
    B  provenance  merge the mappings by claim and value: the same claim from two sources
                   becomes one finding with two citations, and nothing loses its source

Run:  python naive_vs_provenance.py          (offline)
      python naive_vs_provenance.py --live   (real model writes the naive summary)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from provenance import FIXTURE, all_claims, analyze, cites, periods, scripted_model, summarize_naively  # noqa: E402


def main() -> None:
    lab.banner("D5.6  Naive summarization vs claim-source mappings")
    claims = all_claims()
    print(f"{len(claims)} claim-source mappings from {len(FIXTURE['subagents'])} subagents")
    lab.show("one mapping, as returned by the document_analysis subagent", {k: v for k, v in claims[9].items() if k != "agent"})

    lab.section("A - naive: summarize the findings into one paragraph")
    summary = summarize_naively(lab.get_client(scripted_model), claims)
    print(summary)

    lab.section("B - provenance-preserving merge (claim_key -> value -> citations)")
    analysis = analyze(claims)
    index = analysis["index"]
    for g in analysis["groups"]:
        for v in g["variants"]:
            value = f"{v['value']} {v['unit']}" if v["value"] else "-"
            print(f"  {g['claim_key']:26} {value:28} {cites(v, index):10} period {', '.join(sorted(periods(v))) or 'n/a'}")

    lab.section("Checks")
    merged = {g["claim_key"]: g for g in analysis["groups"]}
    total_citations = sum(len(v["citations"]) for g in analysis["groups"] for v in g["variants"])
    lab.check(total_citations == len(claims), "every input mapping survived synthesis as a citation")
    lab.check(len(index) == 12, "all 12 distinct sources are still referenced")
    market = merged["market_size_2025"]["variants"]
    lab.check(
        len(market) == 1 and len({c["source_url"] for c in market[0]["citations"]}) == 2,
        "the same claim from two sources became ONE finding with TWO citations",
    )
    fields = ("evidence_excerpt", "publication_date", "data_collection_period", "methodology")
    lab.check(all(all(f in c for f in fields) for c in claims), "each citation keeps its excerpt, publication date, data period and methodology")
    if not lab.is_live():
        lab.check("http" not in summary and "Report" not in summary, "A: the summary carries no URLs and no document names")
        lab.check("1.2" in summary and "0.8" not in summary, "A: where two credible sources disagreed, the summary silently picked one")
        lab.check("4%" in summary and "9%" not in summary and "2024" not in summary, "A: the newer streaming figure vanished, and the older one lost its period")


if __name__ == "__main__":
    main()
