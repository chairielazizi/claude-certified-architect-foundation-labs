"""Offline stand-in for Claude as a code reviewer (D4.1).

It "notices" everything listed in fixtures/diff_observations.json whose evidence appears in
the diff it was sent, then lets the *system prompt* decide what to report - the way the
real model's output depends on how explicit the instructions are:

* no REPORT/SKIP criteria   -> reports everything it noticed (style nits included)
* "only high-confidence"     -> drops only what it feels unsure about; it is very sure
                               about style nits, so they stay (why the advice fails)
* explicit REPORT/SKIP lists -> reports only listed categories; for comment_accuracy it
                               honours the "contradicts the code" criterion
* SEVERITY RUBRIC present    -> uses the rubric level; otherwise picks inconsistently
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_criteria import load_json  # noqa: E402

OBSERVATIONS: list[dict[str, Any]] = load_json("diff_observations.json")["observations"]


def _bullet_block(system: str, header: str) -> dict[str, str]:
    """Parse '- name: text' lines that follow a header line, up to the next blank line."""
    if header not in system:
        return {}
    block = system.split(header, 1)[1].split("\n\n", 1)[0]
    return dict(re.findall(r"^- (\w+): (.*)$", block, flags=re.MULTILINE))


def scripted_reviewer(params: dict[str, Any]) -> lab.Obj:
    system = lab.system_text(params)
    diff = lab.last_user_text(params)
    noticed = [o for o in OBSERVATIONS if o["evidence"] in diff]

    report = _bullet_block(system, "REPORT only these categories:")
    explicit = bool(report)
    confidence_filter = "high-confidence" in system.lower()
    has_rubric = "SEVERITY RUBRIC" in system

    findings = []
    for obs in noticed:
        if explicit:
            if obs["category"] not in report:
                continue  # listed under SKIP, disabled, or simply not asked for
            if obs["category"] == "comment_accuracy" and "contradicts" in report["comment_accuracy"]:
                if not obs["contradicts_code"]:
                    continue  # imprecise wording is not a contradiction
        elif confidence_filter and obs["self_confidence"] < 0.7:
            continue  # the model only drops what it *feels* unsure about
        findings.append(
            {
                "line": obs["line"],
                "category": obs["category"],
                "severity": obs["rubric_severity"] if has_rubric else obs["unguided_severity"],
                "issue": obs["issue"],
            }
        )
    return lab.message(lab.text(json.dumps({"findings": findings})))
