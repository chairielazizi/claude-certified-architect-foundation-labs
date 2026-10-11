"""D5.1 - Upstream agents return structured data when downstream context is limited.

Four research subagents report to a synthesis step that has a small context budget.
Verbose reports (working logs, reasoning chains, caveats buried in prose) do not fit, so
whole reports get truncated or dropped. The same findings as structured data - key
facts with relevance scores, citations (source, location, date) and a one-line
methodology - fit with room to spare and keep the metadata synthesis needs.

The change is made UPSTREAM, in the subagent's instructions and output format, not by
asking the downstream agent to read faster.

Run:  python upstream_structured_outputs.py          (offline)
      python upstream_structured_outputs.py --live   (real subagents; structured outputs via output_config)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from context_layers import load_fixture  # noqa: E402

FINDINGS = load_fixture("subagent_findings.json")
SYNTHESIS_BUDGET_CHARS = 6000

VERBOSE_PROMPT = "You are a research subagent. Report your findings to the coordinator."
STRUCTURED_PROMPT = (
    "You are a research subagent. The coordinator's synthesis step has a small context budget, so "
    "return ONLY structured data: your scope, a one-line methodology, and key facts. Each key fact has "
    "an id, the fact, a relevance score 0-100 for the research question, and its citation (source, "
    "location, date). No reasoning, no working log, no prose."
)
FINDINGS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "agent": {"type": "string"},
        "scope": {"type": "string"},
        "methodology": {"type": "string"},
        "key_facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "fact": {"type": "string"},
                    "relevance": {"type": "integer"},
                    "source": {"type": "string"},
                    "location": {"type": "string"},
                    "date": {"type": "string"},
                },
                "required": ["id", "fact", "relevance", "source", "location", "date"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["agent", "scope", "methodology", "key_facts"],
    "additionalProperties": False,
}


def compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def verbose_report(agent: dict[str, Any]) -> str:
    return "\n".join(agent["working_log"]) + "\n\n" + agent["verbose"]


def structured_report(agent: dict[str, Any]) -> dict[str, Any]:
    return {"agent": agent["agent"], "scope": agent["scope"], "methodology": agent["methodology"], "key_facts": agent["facts"]}


def subagent_task(agent: dict[str, Any]) -> str:
    # In live mode the subagent condenses its own working notes; offline the scripted
    # subagent returns the fixture's report in whichever format the prompt asks for.
    return (
        f"Research question: {FINDINGS['question']}\nAgent: {agent['agent']}\nScope: {agent['scope']}\n"
        f"Methodology: {agent['methodology']}\n\nYour working notes:\n{verbose_report(agent)}"
    )


def scripted_subagent(params: dict[str, Any]) -> lab.Obj:
    task = lab.last_user_text(params)
    agent = next(a for a in FINDINGS["agents"] if f"Agent: {a['agent']}\n" in task)
    if "return ONLY structured data" in lab.system_text(params):
        return lab.message(lab.text(compact_json(structured_report(agent))))
    return lab.message(lab.text(verbose_report(agent)))


def run_subagent(client: Any, agent: dict[str, Any], structured: bool) -> str:
    params: dict[str, Any] = {
        "model": lab.MODEL,
        "max_tokens": 16000,
        "system": STRUCTURED_PROMPT if structured else VERBOSE_PROMPT,
        "messages": [{"role": "user", "content": subagent_task(agent)}],
    }
    if structured:
        # Structured outputs: the first text block is guaranteed to be JSON matching the schema.
        params["output_config"] = {"format": {"type": "json_schema", "schema": FINDINGS_SCHEMA}}
    text = lab.text_of(client.messages.create(**params))
    return compact_json(json.loads(text)) if structured else text


def pack_into_budget(reports: list[tuple[str, str]], budget: int) -> tuple[str, dict[str, str]]:
    """What a context-limited synthesis step actually receives: reports in arrival order until the budget runs out."""
    packed, fate, remaining = [], {}, budget
    for name, report in reports:
        if len(report) <= remaining:
            packed.append(report)
            fate[name] = "complete"
            remaining -= len(report)
        elif remaining > 0:
            packed.append(report[:remaining])
            fate[name] = f"truncated to {remaining} of {len(report)} chars"
            remaining = 0
        else:
            fate[name] = "dropped"
    return "\n\n".join(packed), fate


def main() -> None:
    lab.banner("D5.1  Upstream agents return structured data for a limited downstream budget")
    print(f"question: {FINDINGS['question']}")
    print(f"synthesis context budget: {SYNTHESIS_BUDGET_CHARS:,} chars")

    contexts: dict[str, str] = {}
    sizes: dict[str, list[int]] = {}
    for key, title, structured in [("verbose", "A - verbose reports", False), ("structured", "B - structured key facts", True)]:
        lab.section(title)
        client = lab.get_client(scripted_subagent)
        reports = [(a["agent"], run_subagent(client, a, structured)) for a in FINDINGS["agents"]]
        sizes[key] = [len(r) for _, r in reports]
        contexts[key], fate = pack_into_budget(reports, SYNTHESIS_BUDGET_CHARS)
        for name, report in reports:
            print(f"  {name:18} {len(report):>6,} chars -> {fate[name]}")
        print(f"  total {sum(sizes[key]):,} chars")
        if structured:
            example = json.loads(reports[1][1])["key_facts"][3]
            lab.show("  one structured fact (note the citation metadata)", example)

    lab.section("Checks")
    total_verbose, total_structured = sum(sizes["verbose"]), sum(sizes["structured"])
    print(f"  structured / verbose = {total_structured * 100 // total_verbose}%")
    lab.check(total_structured <= SYNTHESIS_BUDGET_CHARS, "all four structured reports fit the synthesis budget")
    if not lab.is_live():
        lab.check(total_verbose > SYNTHESIS_BUDGET_CHARS, "the verbose reports do not fit, so later reports get truncated or dropped")
        lab.check(total_structured * 10 <= total_verbose * 6, "structured output is at most 60% of the verbose size, with more information kept")
        lab.check("44%" not in contexts["verbose"], "verbose: the exit survey's top finding (44% 'too expensive') never reached synthesis")
        every_id = [f["id"] for a in FINDINGS["agents"] for f in a["facts"]]
        lab.check(all(f'"id":"{i}"' in contexts["structured"] for i in every_id), "structured: every fact reached synthesis with its id")
        lab.check(contexts["structured"].count('"source":') == len(every_id), "structured: every fact carries its source, location and date")


if __name__ == "__main__":
    main()
