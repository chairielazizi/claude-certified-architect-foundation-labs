"""Tool catalog and per-agent tool distribution for the multi-agent research system (D2.3).

The catalog has 18 tools. Two ways to hand them out:

* ``SCOPED_CONFIG``     - each subagent gets only the tools its role needs (2 or fewer here),
                          plus one deliberate cross-role tool: ``verify_fact`` for the
                          synthesis agent (sample Q9).
* ``EVERYTHING_CONFIG`` - "give everyone everything": all 18 tools on every agent.

``check_distribution`` is the review you would run in CI on an agent config: it warns
when an agent has too many tools or tools outside its specialization.
"""

from __future__ import annotations

from typing import Any

# name -> (category, one-line purpose). Descriptions are short here because this module is
# about WHO gets a tool; D2.1 covers how to write the description itself.
CATALOG: dict[str, tuple[str, str]] = {
    "web_search": ("search", "Search the web and return ranked results"),
    "fetch_url": ("retrieval", "Fetch any URL (generic; replaced by load_document)"),
    "load_document": ("retrieval", "Load an allowlisted https document URL (pdf/html/txt)"),
    "extract_data_points": ("analysis", "Extract named facts from one document"),
    "summarize_content": ("analysis", "Summarise one document"),
    "extract_metadata": ("analysis", "Title, authors, year, DOI of a document"),
    "classify_document": ("analysis", "Classify a document by type and topic"),
    "translate_text": ("analysis", "Translate text between languages"),
    "verify_fact": ("verification", "Check ONE simple fact (date, name, number) against a reference index"),
    "deep_verify_claim": ("verification", "Multi-source investigation of a complex claim"),
    "merge_findings": ("synthesis", "Merge findings from several subagents"),
    "detect_coverage_gaps": ("synthesis", "Find topics the findings do not cover"),
    "format_report": ("report", "Render the final cited report"),
    "generate_chart": ("report", "Render a chart for the report"),
    "export_pdf": ("report", "Export the report as PDF"),
    "send_email": ("comms", "Email a report to recipients"),
    "run_python": ("compute", "Execute arbitrary Python code"),
    "query_database": ("data", "Run SQL against the analytics warehouse"),
}

# Each role's specialization = the tool categories it is supposed to use.
ROLES: dict[str, set[str]] = {
    "web_search_agent": {"search", "retrieval"},
    "document_analysis_agent": {"analysis"},
    "synthesis_agent": {"synthesis"},
    "report_agent": {"report"},
}

# Deliberate, documented exceptions to the specialization rule. Keep this list short:
# every entry should name the high-frequency need that justifies it.
CROSS_ROLE_ALLOWANCES: dict[tuple[str, str], str] = {
    ("synthesis_agent", "verify_fact"): (
        "85% of verification needs are simple fact checks (dates, names, statistics); a scoped "
        "tool removes 2-3 coordinator round trips each. Complex claims still go via the coordinator."
    ),
}

SCOPED_CONFIG: dict[str, list[str]] = {
    "web_search_agent": ["web_search", "load_document"],
    "document_analysis_agent": ["extract_data_points", "summarize_content"],
    "synthesis_agent": ["verify_fact"],  # synthesis works from findings passed in its prompt
    "report_agent": ["format_report"],
}

EVERYTHING_CONFIG: dict[str, list[str]] = {role: list(CATALOG) for role in ROLES}

MAX_TOOLS_PER_AGENT = 6  # beyond ~4-6 tools, selection reliability drops (exam: 18 vs 4-5)


def tool_definition(name: str) -> dict[str, Any]:
    """A Messages API tool definition for a catalog entry (used when building an agent)."""
    category, purpose = CATALOG[name]
    return {
        "name": name,
        "description": f"{purpose}. Category: {category}.",
        "input_schema": {"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"]},
    }


def check_distribution(config: dict[str, list[str]]) -> dict[str, list[tuple[str, str]]]:
    """Per agent: list of (level, message), level in error | warn | info."""
    report: dict[str, list[tuple[str, str]]] = {}
    for role, tools in config.items():
        findings: list[tuple[str, str]] = []
        specialization = ROLES.get(role, set())
        if len(tools) > MAX_TOOLS_PER_AGENT:
            findings.append(("warn", f"{len(tools)} tools (> {MAX_TOOLS_PER_AGENT}): more choices per step, less reliable selection"))
        outside = []
        for tool in tools:
            if tool not in CATALOG:
                findings.append(("error", f"unknown tool {tool}"))
                continue
            category = CATALOG[tool][0]
            if category in specialization:
                continue
            reason = CROSS_ROLE_ALLOWANCES.get((role, tool))
            if reason:
                findings.append(("info", f"scoped cross-role tool {tool}: {reason}"))
            else:
                outside.append(f"{tool}({category})")
        if outside:
            shown = ", ".join(outside[:4]) + (f", +{len(outside) - 4} more" if len(outside) > 4 else "")
            findings.append(("warn", f"{len(outside)} tool(s) outside its specialization {sorted(specialization)}: {shown}"))
        report[role] = findings
    return report


def count(report: dict[str, list[tuple[str, str]]], level: str) -> int:
    return sum(1 for findings in report.values() for lvl, _ in findings if lvl == level)
