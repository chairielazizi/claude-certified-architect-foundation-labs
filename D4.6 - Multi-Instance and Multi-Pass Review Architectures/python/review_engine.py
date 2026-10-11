"""Review prompts, finding schema and the offline reviewer for D4.6's multi-pass demos.

The PR under review (fixtures/pr/inventory, 7 files) contains:
  * the same swallowed-exception construct in repository.py, events.py and audit.py
  * an unvalidated quantity in api.py (negative qty frees reserved stock)
  * two CROSS-FILE bugs no single file shows: service.py calls adjust_stock(qty, sku)
    against def adjust_stock(self, sku, delta); reports.py reads event["quantity"] while
    service.py publishes {"qty": ...}

The offline reviewer applies the same detectors whatever the mode, but what it can see and
how much attention each file gets depends on the request:
  * one <file> per request (local pass)    -> every detector on that file, full depth
  * INTEGRATION in the system prompt         -> only cross-file detectors, across all files
  * many files, one request (single pass)    -> full depth for the first files only; later
    files get a skim that APPROVES constructs it flagged earlier - a deterministic stand-in
    for the attention dilution described in sample question 12
  * VERIFY in the system prompt              -> re-checks one finding against the code
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

PR_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "pr"
PR_ORDER = ["models.py", "repository.py", "service.py", "events.py", "reports.py", "api.py", "audit.py"]
SINGLE_PASS_DEEP_FILES = 2

FORMAT = (
    'Respond with JSON only: {"findings": [{"file", "line", "detected_pattern" (kebab-case), "issue", '
    '"severity" (low|medium|high), "confidence" (0-1: how sure you are it is a real problem)}], '
    '"approved": [{"file", "detected_pattern", "comment"}]}.'
)
LOCAL_PROMPT = (
    "You review ONE file from a pull request for local issues: bugs, error handling, input validation, "
    "resource use. Judge each construct on its merits; the same construct gets the same verdict in every file. "
    + FORMAT
)
INTEGRATION_PROMPT = (
    "INTEGRATION PASS. Local issues inside each file were already reviewed in separate passes. Look only at "
    "cross-file data flow: do call sites match the signatures they call (argument order, units), and do event "
    "payloads match the keys their consumers read? " + FORMAT
)
SINGLE_PASS_PROMPT = "Review this pull request. Report every issue; list constructs you checked and consider fine under approved. " + FORMAT
VERIFY_PROMPT = (
    "VERIFY one finding from an automated review that you did not write. Using only the code provided, decide "
    'whether it is a real problem. Respond with JSON only: {"verdict": "confirmed|rejected|uncertain", '
    '"confidence": 0-1, "evidence": "..."}.'
)


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file: str
    line: int
    detected_pattern: str
    issue: str
    severity: str
    confidence: float = Field(ge=0, le=1)


class Approval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file: str
    detected_pattern: str | None
    comment: str


class ReviewOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    findings: list[Finding]
    approved: list[Approval]


def load_pr() -> dict[str, str]:
    return {name: (PR_DIR / "inventory" / name).read_text(encoding="utf-8") for name in PR_ORDER}


def files_message(files: dict[str, str]) -> str:
    return "\n".join(f'<file path="inventory/{name}">\n{text}</file>' for name, text in files.items())


def parse_files(message: str) -> dict[str, str]:
    return {m[1]: m[2] for m in re.finditer(r'<file path="inventory/([^"]+)">\n(.*?)</file>', message, flags=re.DOTALL)}


def parse_review(text: str) -> ReviewOutput:
    return ReviewOutput.model_validate(json.loads(text[text.find("{") : text.rfind("}") + 1]))


# ---------------------------------------------------------------------------
# Detectors (what a careful reviewer notices)
# ---------------------------------------------------------------------------


def local_findings(name: str, text: str) -> list[dict[str, Any]]:
    lines = text.split("\n")
    out = []
    for i, line in enumerate(lines):
        n = i + 1
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        after = lines[i + 2] if i + 2 < len(lines) else ""
        if line.strip() == "except Exception:" and re.match(r"\s*log(ger)?\.\w+\(", nxt) and "raise" not in after:
            out.append(dict(file=name, line=n, detected_pattern="swallowed-exception", severity="high", confidence=0.9,
                            issue="Exception is logged and swallowed; the caller believes the operation succeeded."))
        m = re.match(r"\s*(\w+) = int\(body\[\"(\w+)\"\]\)", line)
        if m and not re.search(rf"if {m[1]} <= 0|{m[1]} < 1", nxt):
            out.append(dict(file=name, line=n, detected_pattern="unvalidated-quantity", severity="high", confidence=0.85,
                            issue=f"{m[1]} is not checked for > 0; a negative quantity reverses the operation (reserve(-5) frees stock)."))
        mlist = re.match(r"^(\w+) = \[\]$", line)
        if mlist and f"{mlist[1]}.append(" in text and f"{mlist[1]}.clear()" not in text:
            out.append(dict(file=name, line=n, detected_pattern="unbounded-module-list", severity="medium", confidence=0.6,
                            issue=f"Module-level list {mlist[1]} only grows; in a long-running process it is never reset."))
        if name == "models.py" and re.match(r"\s+on_hand: int", line):
            out.append(dict(file=name, line=n, detected_pattern="unenforced-int-annotation", severity="low", confidence=0.4,
                            issue="Quantities are annotated int but nothing enforces it; float quantities could slip in."))
    first_int = next((i + 1 for i, line in enumerate(lines) if "int(body[" in line), None)
    if first_int:
        out.append(dict(file=name, line=first_int, detected_pattern="int-parse-valueerror", severity="medium", confidence=0.55,
                        issue="int() raises ValueError on non-numeric input; unless something maps it, the client gets a 500."))
    return out


def integration_findings(files: dict[str, str]) -> list[dict[str, Any]]:
    out = []
    # 1. call sites vs signatures (positional argument order)
    signatures = {}
    for text in files.values():
        for m in re.finditer(r"def (\w+)\(self, (\w+)[^,)]*, (\w+)", text):
            signatures[m[1]] = (m[2], m[3])
    for name, text in files.items():
        for i, line in enumerate(text.split("\n"), 1):
            for m in re.finditer(r"\.(\w+)\(([\w.]+), ([\w.]+)\)", line):
                if m[1] in signatures:
                    first, second = signatures[m[1]]
                    if m[3].split(".")[-1] == first and m[2].split(".")[-1] != first:
                        out.append(dict(file=name, line=i, detected_pattern="argument-order-mismatch", severity="high", confidence=0.9,
                                        issue=f"{m[1]}({m[2]}, {m[3]}) but the signature is {m[1]}({first}, {second}): sku and quantity are swapped."))
    # 2. event payload keys published vs keys consumers read
    published: dict[str, set[str]] = {}
    for text in files.values():
        for m in re.finditer(r'publish\("([\w.]+)", \{(.*?)\}\)', text):
            published[m[1]] = set(re.findall(r'"(\w+)":', m[2]))
    for name, text in files.items():
        for topic, handler in re.findall(r'subscribe\("([\w.]+)", (\w+)\)', text):
            body = re.search(rf"def {handler}\(\w+\):\n(.*?)(?:\n\n|\Z)", text, flags=re.DOTALL)
            for key in re.findall(r'event\["(\w+)"\]', body[1] if body else ""):
                if topic in published and key not in published[topic]:
                    line = next(i for i, ln in enumerate(text.split("\n"), 1) if f'event["{key}"]' in ln)
                    out.append(dict(file=name, line=line, detected_pattern="event-payload-key-mismatch", severity="high", confidence=0.85,
                                    issue=f"{handler} reads event['{key}'] but '{topic}' is published with keys {sorted(published[topic])}; "
                                          "the KeyError is then swallowed by publish()."))
    return out


def verify(finding: dict[str, Any], files: dict[str, str]) -> dict[str, Any]:
    everything = "\n".join(files.values())
    pattern = finding["detected_pattern"]
    if pattern == "unbounded-module-list":
        var = re.search(r"list (\w+)", finding["issue"])[1]  # type: ignore[index]
        resets = re.findall(rf"{var}\.clear\(\)|^[ \t]+{var} = \[\]", everything, flags=re.MULTILINE)  # indented = a reset
        if not resets:
            return {"verdict": "confirmed", "confidence": 0.85, "evidence": f"{var} is appended to in on_received and never cleared or reassigned in the PR."}
    if pattern == "unenforced-int-annotation" and "int(body[" in everything:
        return {"verdict": "rejected", "confidence": 0.15, "evidence": "Every quantity enters through int(body[...]) in api.py, so floats cannot reach StockItem."}
    if pattern == "int-parse-valueerror" and "except ValueError" not in everything:
        return {"verdict": "uncertain", "confidence": 0.5, "evidence": "No ValueError handling in the PR, but the web framework's error mapping is not part of the diff."}
    return {"verdict": "confirmed", "confidence": finding["confidence"], "evidence": "re-checked against the code"}


# ---------------------------------------------------------------------------
# Offline reviewer
# ---------------------------------------------------------------------------


def scripted_reviewer(params: dict[str, Any]) -> lab.Obj:
    system = lab.system_text(params)
    user = lab.last_user_text(params)
    files = parse_files(user)

    if system.startswith("VERIFY"):
        finding = json.loads(re.search(r"<finding>\n(.*?)\n</finding>", user, flags=re.DOTALL)[1])  # type: ignore[index]
        return lab.message(lab.text(json.dumps(verify(finding, files))))

    if system.startswith("INTEGRATION"):
        return lab.message(lab.text(json.dumps({"findings": integration_findings(files), "approved": []})))

    findings: list[dict[str, Any]] = []
    approved: list[dict[str, Any]] = []
    if len(files) == 1:  # focused local pass: full attention on one file
        (name, text), = files.items()
        findings = local_findings(name, text)
    else:  # everything at once: attention runs out after the first files
        seen_patterns: set[str] = set()
        for index, (name, text) in enumerate(files.items()):
            local = local_findings(name, text)
            if index < SINGLE_PASS_DEEP_FILES:
                findings += local
                seen_patterns |= {f["detected_pattern"] for f in local}
                continue
            skimmed = [f for f in local if f["detected_pattern"] in seen_patterns]
            for f in skimmed:  # recognizes the construct but waves it through this time
                approved.append({"file": name, "detected_pattern": f["detected_pattern"], "comment": "Error handling logs the failure; looks fine."})
            if not skimmed:
                approved.append({"file": name, "detected_pattern": None, "comment": "Looks good."})
    return lab.message(lab.text(json.dumps({"findings": findings, "approved": approved})))
