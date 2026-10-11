"""D1.6 (a) - Prompt chaining: a fixed review pipeline for a multi-file pull request.

    step 1  per-file local pass     one focused call per file (only that file in context)
                                    -> local issues + exported interfaces + outgoing calls
    step 2  integration pass        ONE call that sees every file's report, not the sources
                                    -> cross-file mismatches (signature drift, data flow)
    step 3  merge                   plain code: combine both into the review

PR #1482 changed billing.calculate_total(items, tax_rate) to calculate_total(items, region),
but api.py still calls it with tax_rate=. No single file is wrong on its own, so no per-file
pass can see it. The integration pass can. For contrast, a single pass over all files at once
shows the attention-dilution failure from sample question 12.

Run:  python pr_review_chain.py          (offline, scripted reviewer)
      python pr_review_chain.py --live   (real Claude API, structured JSON outputs)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from choose_strategy import EXAMPLES, choose_strategy  # noqa: E402
from code_analysis import FIXTURES, read_dir  # noqa: E402
from scripted_models import scripted_model  # noqa: E402

PER_FILE_SYSTEM = (
    "PER-FILE REVIEWER. You review exactly ONE file of a pull request. Report only issues you can verify "
    "inside this file (bugs, error handling, edge cases), with line numbers. Also list the file's exported "
    "function signatures and every call it makes to a symbol imported from another module, verbatim. "
    "You cannot see other files: do not guess about them."
)
INTEGRATION_SYSTEM = (
    "INTEGRATION REVIEWER. You receive per-file reports (summary, exported signatures, outgoing calls, local "
    "issues) for every file in a pull request. Find problems that span files: calls that do not match the "
    "callee's current signature, inconsistent data flow, and local issues that hide cross-file failures. "
    "Do not repeat purely local issues."
)
SINGLE_PASS_SYSTEM = "SINGLE-PASS REVIEWER. Review every file of this pull request in one pass and list all issues."

ISSUE = {
    "type": "object",
    "properties": {"line": {"type": "integer"}, "issue": {"type": "string"}},
    "required": ["line", "issue"],
    "additionalProperties": False,
}
CALL = {
    "type": "object",
    "properties": {"symbol": {"type": "string"}, "module": {"type": "string"}, "call": {"type": "string"}},
    "required": ["symbol", "module", "call"],
    "additionalProperties": False,
}
FILE_REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "file": {"type": "string"},
        "summary": {"type": "string"},
        "local_issues": {"type": "array", "items": ISSUE},
        "exports": {"type": "array", "items": {"type": "string"}},
        "external_calls": {"type": "array", "items": CALL},
    },
    "required": ["file", "summary", "local_issues", "exports", "external_calls"],
    "additionalProperties": False,
}
INTEGRATION_SCHEMA = {
    "type": "object",
    "properties": {
        "cross_file_issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"caller": {"type": "string"}, "callee": {"type": "string"}, "issue": {"type": "string"}},
                "required": ["caller", "callee", "issue"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["cross_file_issues"],
    "additionalProperties": False,
}
SINGLE_PASS_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"file": {"type": "string"}, "issue": {"type": "string"}},
                "required": ["file", "issue"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["findings"],
    "additionalProperties": False,
}


def file_block(name: str, source: str) -> str:
    return f"### FILE: {name}\n{source if source.endswith(chr(10)) else source + chr(10)}### END FILE\n"


def ask_json(client: Any, system: str, prompt: str, schema: dict[str, Any], sent: list[str]) -> dict[str, Any]:
    """One chain step. Structured outputs make the step's result machine-readable for the next step."""
    sent.append(prompt)
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    return json.loads(lab.text_of(response))


def review_pr(client: Any, files: dict[str, str]) -> dict[str, Any]:
    sent: list[str] = []
    # Step 1: one focused call per file. The calls are independent, so they could run in parallel.
    reports = [
        ask_json(client, PER_FILE_SYSTEM, f"PR #1482, one changed file:\n\n{file_block(name, src)}", FILE_REPORT_SCHEMA, sent)
        for name, src in files.items()
    ]
    # Step 2: the integration pass sees compact reports (interfaces + calls), never the full sources.
    integration = ask_json(
        client, INTEGRATION_SYSTEM, f"PR #1482.\nPER-FILE REPORTS:\n{json.dumps(reports, indent=2)}", INTEGRATION_SCHEMA, sent
    )
    # Step 3: merge (deterministic code, no model call).
    comments = [f"{r['file']}:{i['line']}  {i['issue']}" for r in reports for i in r["local_issues"]]
    comments += [f"{c['caller']} -> {c['callee']}  {c['issue']}" for c in integration["cross_file_issues"]]
    return {"reports": reports, "integration": integration, "comments": comments, "prompts": sent}


def main() -> None:
    lab.banner("D1.6  Prompt chaining: per-file passes + cross-file integration pass")
    strategy, reason = choose_strategy(EXAMPLES[0])
    print(f"task: {EXAMPLES[0]['task']}\nstrategy: {strategy} ({reason})")
    files = read_dir(FIXTURES / "pr_1482")
    print(f"files in PR: {list(files)}")

    lab.section("Step 1: per-file local analysis (one call per file)")
    client = lab.get_client(scripted_model)
    result = review_pr(client, files)
    for report in result["reports"]:
        print(f"{report['file']}: {report['summary']}")
        print(f"    exports: {report['exports']}")
        for issue in report["local_issues"]:
            print(f"    line {issue['line']}: {issue['issue']}")

    lab.section("Step 2: cross-file integration pass")
    for issue in result["integration"]["cross_file_issues"]:
        print(f"  {issue['caller']} -> {issue['callee']}\n    {issue['issue']}")

    lab.section("Step 3: merged review comments")
    for comment in result["comments"]:
        print(f"  - {comment}")

    lab.section("Contrast: one pass over all files at once")
    single = ask_json(
        lab.get_client(scripted_model), SINGLE_PASS_SYSTEM, "PR #1482:\n\n" + "".join(file_block(n, s) for n, s in files.items()),
        SINGLE_PASS_SCHEMA, [],
    )
    for finding in single["findings"]:
        print(f"  {finding['file']}: {finding['issue']}")

    lab.section("Checks")
    per_file_prompts, integration_prompt = result["prompts"][:-1], result["prompts"][-1]
    lab.check(all(p.count("### FILE:") == 1 for p in per_file_prompts), "each per-file call had exactly one file in context")
    lab.check("### FILE:" not in integration_prompt and all(n in integration_prompt for n in files), "the integration pass saw every file's report but no full sources")
    if not lab.is_live():
        local_text = " ".join(i["issue"] for r in result["reports"] for i in r["local_issues"])
        lab.check("tax_rate" not in local_text, "no per-file pass flagged the signature change (the callee was not in its context)")
        cross = result["integration"]["cross_file_issues"]
        lab.check(
            len(cross) == 1 and cross[0]["caller"] == "api.py" and cross[0]["callee"] == "billing.calculate_total" and "tax_rate" in cross[0]["issue"],
            "the integration pass caught api.py calling calculate_total(..., tax_rate=) after billing.py changed it",
        )
        lab.check(all(c["caller"] != "reports.py" for c in cross), "reports.py's correct call (region=...) was not flagged")
        files_with_local = {r["file"] for r in result["reports"] if r["local_issues"]}
        single_files = {f["file"] for f in single["findings"] if f["issue"] != "Looks fine."}
        lab.check(files_with_local == {"api.py", "billing.py", "cart.py"}, "per-file passes found the local bug in every file that has one")
        lab.check("cart.py" not in single_files, "the single pass skimmed later files and missed cart.py's off-by-one (attention dilution)")


if __name__ == "__main__":
    main()
