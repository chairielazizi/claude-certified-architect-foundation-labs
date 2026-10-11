"""D5.6 - The synthesis report: explicit sections, provenance on every claim.

    ## Well-established findings
        ### Financial data      -> markdown table (value, data period, sources)
        ### News                -> prose, citations inline
        ### Technical findings  -> bulleted list with methodology
    ## Contested findings       -> both values, both sources, the coordinator's decision
    ## Coverage gaps            -> requested subtopics no source covered
    ## Sources                  -> document, URL, publication date, data period, methodology

Run:  python provenance_report.py          (offline)
      python provenance_report.py --live   (real model as coordinator)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from provenance import all_claims, analyze, claim_units, reconcile, render_report, scripted_model, section  # noqa: E402


def main() -> None:
    lab.banner("D5.6  Synthesis report with provenance and content-appropriate rendering")
    analysis = analyze(all_claims())
    decisions = reconcile(lab.get_client(scripted_model), analysis["conflicts"])
    report = render_report(analysis, decisions)
    print(report)

    lab.section("Checks")
    units = claim_units(report)
    established = section(report, "Well-established findings")
    contested = section(report, "Contested findings")
    financial = section(established, "Financial data", "### ")
    news = section(established, "News", "### ")
    technical = section(established, "Technical findings", "### ")
    # 3 table rows + 2 news sentences + 2 technical bullets + 1 contested bullet
    lab.check(len(units) == 8 and all("[S" in u for u in units), f"all {len(units)} rendered claims carry at least one citation")
    lab.check(
        "1.2 USD bn" in contested and "0.8 USD bn" in contested and "[S2]" in contested and "[S5]" in contested,
        "the contested section keeps both values, each attributed to its source",
    )
    lab.check(
        "streaming" not in contested and "Temporal difference, not a contradiction" in established,
        "the 2024 vs 2026 streaming figures are presented as a trend, not as a contradiction",
    )
    lab.check("session musician employment" in section(report, "Coverage gaps"), "the uncovered subtopic is reported as a coverage gap")
    lab.check(
        "| Finding |" in financial and "- " not in news and "|" not in news
        and all(line.startswith("- ") for line in technical.split("\n") if line.strip()),
        "financial data is a table, news is prose, technical findings are a bulleted list",
    )
    lab.check("[S1] [S4]" in financial, "the market-size row cites both agreeing sources")
    sources = [line for line in section(report, "Sources").split("\n") if line.startswith("- [S")]
    lab.check(len(sources) == 12 and all("Published" in s and "data " in s for s in sources), "every source lists its publication date and data period")


if __name__ == "__main__":
    main()
