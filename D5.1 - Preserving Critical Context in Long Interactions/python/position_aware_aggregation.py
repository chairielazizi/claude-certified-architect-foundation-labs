"""D5.1 - Position-aware aggregation: key findings first, explicit section headers.

Models reliably use the beginning and end of a long input but can miss findings in the
middle ("lost in the middle"). When aggregating subagent results for a synthesis step:

  * put a key-findings summary at the BEGINNING (highest relevance first, with citations)
  * organise the detailed results under explicit section headers, one per source

Offline, the synthesis model is a deliberately simple positional reader: it attends to
the first 25% and the last 15% of its input, plus the first line under each markdown
header. That caricature of the effect makes the difference visible and deterministic.
In live mode the real model reads the same two inputs.

Run:  python position_aware_aggregation.py          (offline)
      python position_aware_aggregation.py --live   (real API)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from context_layers import load_fixture  # noqa: E402

FINDINGS = load_fixture("subagent_findings.json")
TOP_N = 4
SYSTEM = "You are the synthesis agent. Name the main drivers of the churn increase and cite the fact ids you rely on."


def fact_line(f: dict[str, Any]) -> str:
    return f"- [{f['id']}] {f['fact']} (relevance {f['relevance']}; {f['source']}, {f['location']}, {f['date']})"


def build_naive(agents: list[dict[str, Any]]) -> str:
    """Results concatenated in arrival order: no summary, no headers."""
    return "\n".join(fact_line(f) for a in agents for f in a["facts"])


def build_position_aware(agents: list[dict[str, Any]], top_n: int = TOP_N) -> str:
    ranked = sorted((f for a in agents for f in a["facts"]), key=lambda f: -f["relevance"])  # stable on ties
    lines = ["## Key findings (highest relevance first)"] + [fact_line(f) for f in ranked[:top_n]]
    lines += ["", "## Detailed results"]
    for a in agents:
        lines += ["", f"### {a['agent']}: {a['scope']}", f"Methodology: {a['methodology']}"]
        lines += [fact_line(f) for f in a["facts"]]
    return "\n".join(lines)


def attended_lines(text: str) -> list[str]:
    """The simulated reader's attention: head, tail, and the line right under each header."""
    lines = text.split("\n")
    total, offset, seen = len(text), 0, []
    for i, line in enumerate(lines):
        start = offset
        offset += len(line) + 1
        in_head = start * 100 < total * 25
        in_tail = start * 100 >= total * 85
        under_header = i > 0 and lines[i - 1].startswith("#")
        if in_head or in_tail or under_header:
            seen.append(line)
    return seen


FACT_RE = re.compile(r"^- \[([A-Z]\d+)\] (.+?) \(relevance (\d+);", re.M)


def scripted_synthesizer(params: dict[str, Any]) -> lab.Obj:
    found: dict[str, tuple[int, str]] = {}
    for fact_id, fact, relevance in FACT_RE.findall("\n".join(attended_lines(lab.last_user_text(params)))):
        found[fact_id] = (int(relevance), fact)
    drivers = sorted((item for item in found.items() if item[1][0] >= 70), key=lambda item: (-item[1][0], item[0]))
    if not drivers:
        return lab.message(lab.text("I could not identify a clear driver."))
    return lab.message(lab.text("Main drivers: " + " ".join(f"[{i}] {fact}" for i, (_, fact) in drivers)))


def synthesize(client: Any, aggregated: str) -> str:
    content = f"Question: {FINDINGS['question']}\n\n{aggregated}"
    response = client.messages.create(model=lab.MODEL, max_tokens=16000, system=SYSTEM, messages=[{"role": "user", "content": content}])
    return lab.text_of(response)


def main() -> None:
    lab.banner("D5.1  Position-aware aggregation (mitigating lost-in-the-middle)")
    agents = FINDINGS["agents"]
    naive = build_naive(agents)
    aware = build_position_aware(agents)
    critical = "[T4]"
    position = naive.index(critical) * 100 // len(naive)
    print(f"most relevant finding {critical} sits at {position}% of the naive input ({len(naive):,} chars)")

    lab.section("A - naive concatenation")
    print("\n".join(naive.split("\n")[:3]) + "\n  ...")
    naive_answer = synthesize(lab.get_client(scripted_synthesizer), naive)
    print(f"synthesis: {naive_answer}")

    lab.section("B - key findings first + section headers")
    print("\n".join(aware.split("\n")[:8]) + "\n  ...")
    aware_answer = synthesize(lab.get_client(scripted_synthesizer), aware)
    print(f"synthesis: {aware_answer}")

    lab.section("Checks")
    headers = [line for line in aware.split("\n") if line.startswith("### ")]
    lab.check(aware.startswith("## Key findings"), "B: the key-findings summary is the very first thing in the input")
    lab.check(
        aware.index("## Detailed results") > aware.index(critical) and len(headers) == len(agents),
        "B: the top finding is inside the summary, and every subagent's detail has its own header",
    )
    lab.check(25 < position < 85, "A: the most relevant finding sits in the middle of the naive input")
    if not lab.is_live():
        lab.check(critical not in naive_answer, "A: the positional reader missed the most relevant finding")
        lab.check(all(f"[{i}]" in aware_answer for i in ["T4", "S1", "B1", "T1"]), "B: all four top findings made it into the synthesis")


if __name__ == "__main__":
    main()
