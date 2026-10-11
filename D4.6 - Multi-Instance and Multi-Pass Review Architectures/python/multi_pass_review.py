"""D4.6 - Single-pass review of a 7-file PR vs per-file passes + an integration pass (sample Q12).

    single pass, all files in one request -> deep on the first files, skims the rest:
        flags a construct in one file and APPROVES the identical construct elsewhere,
        misses an obvious bug in a later file
    per-file passes, identical prompt      -> one file per request, consistent verdicts
    integration pass                       -> cross-file data flow (signatures vs call sites,
                                              event payload keys) that no single file shows

Run:  python multi_pass_review.py          (offline, scripted reviewer)
      python multi_pass_review.py --live   (real Claude API: 1 + 7 + 1 calls)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from review_engine import (  # noqa: E402
    INTEGRATION_PROMPT,
    LOCAL_PROMPT,
    SINGLE_PASS_PROMPT,
    Finding,
    ReviewOutput,
    files_message,
    load_pr,
    local_findings,
    parse_review,
    scripted_reviewer,
)


def call(client: Any, system: str, content: str) -> ReviewOutput:
    response = client.messages.create(
        model=lab.MODEL, max_tokens=16000, system=system, messages=[{"role": "user", "content": content}]
    )
    return parse_review(lab.text_of(response))


def review_single_pass(client: Any, files: dict[str, str]) -> ReviewOutput:
    return call(client, SINGLE_PASS_PROMPT, files_message(files))


def review_per_file(client: Any, files: dict[str, str]) -> list[Finding]:
    findings: list[Finding] = []
    for name, text in files.items():  # same prompt, one file each: same depth for every file
        findings += call(client, LOCAL_PROMPT, files_message({name: text})).findings
    return findings


def review_integration(client: Any, files: dict[str, str]) -> list[Finding]:
    return call(client, INTEGRATION_PROMPT, files_message(files)).findings


def run_multi_pass(client: Any, files: dict[str, str]) -> tuple[list[Finding], list[Finding]]:
    return review_per_file(client, files), review_integration(client, files)


def has(findings: list[Finding], pattern: str, file: str | None = None) -> bool:
    return any(f.detected_pattern == pattern and (file is None or f.file == file) for f in findings)


def show_findings(findings: list[Finding]) -> None:
    for f in findings:
        loc = f"{f.file}:{f.line}"
        print(f"  {loc:<17} {f.detected_pattern:<27} {f.severity:<6} conf={f.confidence:.2f}  {f.issue[:58]}")


def main() -> None:
    lab.banner("D4.6  Multi-pass review: per-file passes + integration pass")
    files = load_pr()
    print(f"PR: {len(files)} files: {', '.join(files)}")

    lab.section("1. Single pass: all 7 files in one request")
    single_client = lab.get_client(scripted_reviewer)
    single = review_single_pass(single_client, files)
    show_findings(single.findings)
    for a in single.approved:
        print(f"  {a.file:<17} approved {a.detected_pattern or '(file)'}: {a.comment}")
    flagged = {(f.detected_pattern, f.file) for f in single.findings}
    contradictions = sorted(
        {(a.detected_pattern, a.file) for a in single.approved if a.detected_pattern and any(p == a.detected_pattern for p, _ in flagged)}
    )
    print(f"  contradictions (flagged in one file, approved in another): {contradictions}")

    lab.section("2. Per-file passes: identical prompt, one file per request")
    local_client = lab.get_client(scripted_reviewer)
    local = review_per_file(local_client, files)
    show_findings(local)

    lab.section("3. Integration pass: cross-file data flow only")
    integration = review_integration(lab.get_client(scripted_reviewer), files)
    show_findings(integration)

    lab.section("Comparison")
    multi = local + integration
    rows = [
        ("findings", len(single.findings), len(multi)),
        ("contradictory verdicts", len(contradictions), 0),
        ("api.py negative quantity", has(single.findings, "unvalidated-quantity"), has(multi, "unvalidated-quantity")),
        ("swapped adjust_stock args", has(single.findings, "argument-order-mismatch"), has(multi, "argument-order-mismatch")),
        ("event key qty vs quantity", has(single.findings, "event-payload-key-mismatch"), has(multi, "event-payload-key-mismatch")),
    ]
    print(f"  {'':<28}{'single pass':>12}{'multi-pass':>12}")
    for label, a, b in rows:
        print(f"  {label:<28}{str(a):>12}{str(b):>12}")

    if not lab.is_live():
        # Where the swallowed-exception construct really appears (ground truth from the detector).
        construct_files = {name for name, text in files.items() if any(f["detected_pattern"] == "swallowed-exception" for f in local_findings(name, text))}
        local_hits = [f for f in local if f.detected_pattern == "swallowed-exception"]
        per_file_calls = local_client.messages.calls
        lab.check(
            ("swallowed-exception", "events.py") in contradictions and has(single.findings, "swallowed-exception", "repository.py"),
            "single pass: the same construct is flagged in repository.py and approved in events.py",
        )
        lab.check(not has(single.findings, "unvalidated-quantity"), "single pass: the obvious negative-quantity bug in a late file is missed")
        lab.check(
            len(per_file_calls) == len(files)
            and len({c["system"] for c in per_file_calls}) == 1
            and all(c["messages"][0]["content"].count("<file ") == 1 for c in per_file_calls),
            "per-file passes: one file per request, all with the identical prompt",
        )
        lab.check(
            {f.file for f in local_hits} == construct_files and len({(f.severity, f.confidence) for f in local_hits}) == 1,
            "per-file passes: the construct gets the same verdict and severity in all 3 files",
        )
        lab.check(has(local, "unvalidated-quantity", "api.py"), "per-file passes: the api.py bug gets full attention and is found")
        lab.check(
            has(integration, "argument-order-mismatch", "service.py") and has(integration, "event-payload-key-mismatch", "reports.py"),
            "integration pass: both cross-file bugs found",
        )
        lab.check(
            not has(local, "argument-order-mismatch") and not has(local, "event-payload-key-mismatch"),
            "...which no per-file pass could see: each needs two files at once",
        )


if __name__ == "__main__":
    main()
