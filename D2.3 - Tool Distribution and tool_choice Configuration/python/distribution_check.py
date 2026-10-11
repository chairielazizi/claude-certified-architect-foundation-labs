"""D2.3 - Review how tools are distributed across subagents, and route verification (Q9).

  1. scoped config:            every agent has only its role's tools (+ verify_fact, justified)
  2. "give everyone everything": 18 tools per agent -> warnings for count and specialization
  3. sample Q9 option C:        synthesis agent given the web search tools -> flagged
  4. verification routing:      simple facts via the scoped verify_fact, complex claims
                                back through the coordinator; round trips before vs after

Always offline (no model involved). Run:  python distribution_check.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from tool_registry import (  # noqa: E402
    EVERYTHING_CONFIG,
    SCOPED_CONFIG,
    check_distribution,
    count,
    tool_definition,
)

# Fictional claims a synthesis agent meets while combining findings (85% simple / 15% complex).
CLAIMS = [
    "Studio Aurora released 'Glass Harbor' on 14 March 2025.",
    "The Northwind Music Report puts 2025 streaming revenue at $31.2B.",
    "Lumen Labs was founded in 2019.",
    "Painter Ada Brandt won the 2024 Halden Prize.",
    "The Halden Prize is awarded in Oslo.",
    "Vireo Pictures employs 1,200 people.",
    "The SoundSmith plugin reached version 2.0 in 2024.",
    "Novella Press published 340 titles in 2025.",
    "Composer Rui Tanaka scored 'Low Tide'.",
    "The Creative AI Survey had 4,800 respondents.",
    "Pixelforge v6 shipped on 2 December 2025.",
    "The Brightline Festival takes place in Lisbon.",
    "Mara Quinn is the CEO of Lumen Labs.",
    "'Low Tide' runs 118 minutes.",
    "The guild agreement was signed on 9 October 2025.",
    "Northwind counted 61% of labels using AI mastering.",
    "Echo Records is headquartered in Manchester.",
    "AI tools caused the drop in stock-illustration prices since 2023.",
    "Compared with 2022, AI-assisted films earn more at the box office.",
    "There is a consensus among session musicians that AI will reduce their work.",
]

# verify_fact's description draws the boundary the synthesis agent applies: one atomic,
# checkable fact -> verify_fact; causal / comparative / consensus claims -> coordinator.
COMPLEX_MARKERS = re.compile(r"\b(caus\w*|led to|due to|because|compared|more than|consensus|trend|impact)\b", re.I)
ROUND_TRIPS_VIA_COORDINATOR = 2  # synthesis -> coordinator -> web search agent -> coordinator -> synthesis


def route_claim(claim: str) -> str:
    return "coordinator" if COMPLEX_MARKERS.search(claim) else "verify_fact"


def print_report(report: dict[str, list[tuple[str, str]]]) -> None:
    for role, findings in report.items():
        print(f"  {role}: {'ok' if not findings else ''}")
        for level, message in findings:
            print(f"      [{level}] {message}")


def main() -> None:
    lab.banner("D2.3  Scoped tool distribution across subagents")

    lab.section("1. Scoped config (role tools only)")
    print(f"  {json.dumps(SCOPED_CONFIG)}")
    scoped = check_distribution(SCOPED_CONFIG)
    print_report(scoped)

    lab.section("2. 'Give everyone everything' (18 tools per agent)")
    everything = check_distribution(EVERYTHING_CONFIG)
    print_report(everything)
    chars = {
        name: sum(len(json.dumps(tool_definition(t))) for t in tools)
        for name, tools in (("scoped synthesis_agent", SCOPED_CONFIG["synthesis_agent"]), ("everything synthesis_agent", EVERYTHING_CONFIG["synthesis_agent"]))
    }
    print(f"  tool-definition payload per request: {chars} (chars; every turn, every agent)")

    lab.section("3. Sample Q9 option C: give synthesis the web search tools")
    option_c = {**SCOPED_CONFIG, "synthesis_agent": ["verify_fact", "web_search", "load_document"]}
    option_c_report = check_distribution(option_c)
    print_report({"synthesis_agent": option_c_report["synthesis_agent"]})

    lab.section("4. Verification routing with the scoped verify_fact (sample Q9 option A)")
    routes = {claim: route_claim(claim) for claim in CLAIMS}
    for claim, route in routes.items():
        if route == "coordinator":
            print(f"  -> coordinator (deep check): {claim}")
    simple = sum(1 for r in routes.values() if r == "verify_fact")
    before = len(CLAIMS) * ROUND_TRIPS_VIA_COORDINATOR
    after = (len(CLAIMS) - simple) * ROUND_TRIPS_VIA_COORDINATOR
    print(f"  {simple}/{len(CLAIMS)} claims ({simple / len(CLAIMS):.0%}) handled in-agent by verify_fact")
    print(f"  coordinator round trips for verification: before {before}, after {after}")

    lab.section("Checks")
    lab.check(count(scoped, "warn") == 0 and count(scoped, "error") == 0, "scoped config passes: no agent over the limit or outside its role")
    lab.check(count(scoped, "info") == 1, "the one cross-role tool (verify_fact on synthesis) is explicit and justified")
    lab.check(all(any("18 tools" in m for _, m in f) for f in everything.values()), "every agent in the 18-tool config is flagged for tool count")
    lab.check(any("web_search" in m for _, m in everything["synthesis_agent"]), "synthesis agent holding web_search is flagged as outside its specialization")
    lab.check(any(lvl == "warn" for lvl, _ in option_c_report["synthesis_agent"]), "Q9 option C (all web tools on synthesis) is flagged as over-provisioned")
    lab.check(simple == 17 and after < before, f"85% of checks stay local; coordinator round trips {before} -> {after}")
    lab.check(all(route_claim(c) == "coordinator" for c in CLAIMS[-3:]), "complex claims still go through the coordinator (not handled by verify_fact)")


if __name__ == "__main__":
    main()
