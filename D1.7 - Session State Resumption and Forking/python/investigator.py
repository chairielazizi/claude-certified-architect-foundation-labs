"""The auth-investigation agent used by both D1.7 demos: tools, a model-driven scripted model,
and the helpers that turn an instruction into "which files do I need to (re-)read".

The scripted model decides from the conversation, like Claude would:
  * a first instruction          -> list_files, then read every file
  * "Since our last session ..." -> read ONLY the files the message names
  * "STRUCTURED SUMMARY ..."     -> read ONLY the files under "Files to re-read"
  * "Strategy A/B ..." (fork)    -> no tools; plan tests from the findings already in context
and ends each analysis with a machine-readable line:  FINDINGS_JSON: {"auth/x.py": [...]}
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from workspace import list_files  # noqa: E402

SYSTEM_PROMPT = (
    "You are investigating the auth package of a codebase for security issues. Use list_files and "
    "read_file; never guess file contents. When you finish an analysis, end your reply with one line "
    'exactly like: FINDINGS_JSON: {"auth/file.py": ["finding", ...]} covering every file you read in '
    "this turn (use an empty list when a file has no issues)."
)

INVESTIGATE = "Start a security review of the auth package in this workspace. Read every file before concluding."
STRATEGIES = {
    "strategy-a": "Strategy A: plan unit tests with mocks for the open findings. Name the first three tests.",
    "strategy-b": "Strategy B: plan integration tests against a throwaway IdP and sqlite DB for the open findings. "
    "Name the first three tests.",
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_files",
        "description": "List every Python file in the workspace (paths relative to the workspace root).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_file",
        "description": "Read one file from the workspace by its relative path, e.g. auth/login.py.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Relative path such as auth/login.py"}},
            "required": ["path"],
        },
    },
]

# (pattern that must match, pattern that must NOT match or None, finding). Stand-in for real analysis.
RULES: list[tuple[str, str | None, str]] = [
    (r'password == stored\["password"\]', None, "plaintext password comparison with == (store hashes, compare in constant time)"),
    (r"random\.random\(\)", None, "session ids from random.random() are predictable (use secrets.token_urlsafe)"),
    (r"jwt\.encode\(", r'"exp"', "JWTs have no exp claim, so tokens never expire"),
    (r'^SECRET = "', None, "signing secret is hard-coded in source"),
    (r'startswith\("/pub"\)', None, "auth bypass prefix '/pub' also matches '/publish' and '/pub-admin'"),
    (r"verify=False", None, "TLS certificate verification is disabled (verify=False)"),
]


def analyze_source(text: str) -> list[str]:
    return [
        finding
        for pattern, absent, finding in RULES
        if re.search(pattern, text, re.M) and not (absent and re.search(absent, text, re.M))
    ]


def execute_tool(root: Path, name: str, tool_input: dict[str, Any]) -> tuple[str, bool]:
    if name == "list_files":
        return json.dumps(list_files(root)), False
    if name == "read_file":
        target = (root / str(tool_input.get("path", ""))).resolve()
        if not target.is_relative_to(root.resolve()) or not target.is_file():
            return json.dumps({"error": f"No such file in workspace: {tool_input.get('path')}"}), True
        return target.read_text(encoding="utf-8"), False
    return json.dumps({"error": f"Unknown tool {name}"}), True


# ---------------------------------------------------------------------------
# Instruction -> files to read; findings formatting
# ---------------------------------------------------------------------------


def _bullets_after(heading: str, text: str) -> list[str]:
    block = text.split(heading, 1)[1].splitlines()[1:]
    paths = []
    for line in block:
        if not line.startswith("- "):
            break
        paths.append(line[2:].split(" ")[0])
    return paths


def targets_for(instruction: str) -> list[str] | None:
    """Files the instruction asks to (re-)read; None means 'discover them with list_files'."""
    if instruction.startswith("Since our last session"):
        lines = [l for l in instruction.splitlines() if l.startswith("- ") and "(deleted" not in l]
        return [l[2:].split(" ")[0] for l in lines]
    if instruction.startswith("STRUCTURED SUMMARY"):
        return _bullets_after("Files to re-read:", instruction)
    return None


def is_strategy_request(instruction: str) -> bool:
    return instruction.startswith("Strategy ")


def format_findings(findings: dict[str, list[str]]) -> str:
    lines = [f"Analysed {len(findings)} file(s):"]
    for path, issues in findings.items():
        lines.append(f"- {path}: {'; '.join(issues) if issues else 'no issues'}")
    lines.append("FINDINGS_JSON: " + json.dumps(findings))
    return "\n".join(lines)


def parse_findings(text: str) -> dict[str, list[str]]:
    """The last FINDINGS_JSON line of a reply ({} if the model did not produce one)."""
    matches = re.findall(r"^FINDINGS_JSON:\s*(\{.*\})\s*$", text, re.M)
    try:
        return json.loads(matches[-1]) if matches else {}
    except json.JSONDecodeError:
        return {}


def strategy_plan(instruction: str, findings: dict[str, list[str]]) -> str:
    """The answer a fork gives: a test plan derived from the shared analysis baseline."""
    if instruction.startswith("Strategy A"):
        # One isolated test per open finding, collaborators mocked.
        items = [(path, issue) for path, issues in findings.items() for issue in issues][:3]
        tests = [f"{i}. test_{Path(p).stem}_{i} (unit, mocked): {issue}" for i, (p, issue) in enumerate(items, start=1)]
        return "Strategy A - unit tests with mocks (jwt, random, bcrypt patched). First tests:\n" + "\n".join(tests)
    # One end-to-end flow per pair of files with open findings, real collaborators.
    files = [p for p, issues in findings.items() if issues]
    pairs = [files[i : i + 2] for i in range(0, len(files), 2)][:3]
    tests = [f"{i}. test_flow_{i}_end_to_end: drives {' + '.join(pair)} together" for i, pair in enumerate(pairs, start=1)]
    return "Strategy B - integration tests against a throwaway IdP and sqlite DB. First tests:\n" + "\n".join(tests)


# ---------------------------------------------------------------------------
# Scripted model (offline stand-in for Claude)
# ---------------------------------------------------------------------------


def _instruction_index(messages: list[dict[str, Any]]) -> int:
    """Index of the latest user message that is an instruction (text), not tool results."""
    return max(i for i, m in enumerate(messages) if m["role"] == "user" and isinstance(m["content"], str))


def findings_in_context(messages: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Merge every FINDINGS_JSON the assistant produced so far (later ones win)."""
    merged: dict[str, list[str]] = {}
    for m in messages:
        if m["role"] == "assistant":
            text = "".join(b.get("text", "") for b in m["content"] if b.get("type") == "text")
            merged.update(parse_findings(text))
    return merged


def scripted_investigator(params: dict[str, Any]) -> lab.Obj:
    messages = params["messages"]
    start = _instruction_index(messages)
    instruction = messages[start]["content"]

    if is_strategy_request(instruction):
        return lab.message(lab.text(strategy_plan(instruction, findings_in_context(messages[:start]))))

    # What has happened since this instruction: which tools ran and what they returned.
    calls: dict[str, dict[str, Any]] = {}
    results: dict[str, str] = {}
    for m in messages[start + 1 :]:
        for block in m["content"]:
            if block.get("type") == "tool_use":
                calls[block["id"]] = block
            elif block.get("type") == "tool_result":
                results[block["tool_use_id"]] = block["content"]
    read = {calls[i]["input"]["path"]: text for i, text in results.items() if calls[i]["name"] == "read_file"}
    listed = [json.loads(text) for i, text in results.items() if calls[i]["name"] == "list_files"]

    targets = targets_for(instruction)
    if targets is None:
        if not listed:
            return lab.message(lab.text("Let me see which files exist."), lab.tool_use("list_files", {}))
        targets = listed[-1]
    pending = [t for t in targets if t not in read]
    if pending:
        # Read every remaining file in ONE turn (parallel tool calls).
        return lab.message(*[lab.tool_use("read_file", {"path": p}) for p in pending])
    return lab.message(lab.text(format_findings({p: analyze_source(read[p]) for p in targets})))


def offline_answer(root: Path, instruction: str, context_findings: dict[str, list[str]]) -> str:
    """What the scripted investigator would conclude for one prompt, without the tool loop.
    Used by the offline stand-in for the Agent SDK, where Claude Code runs the tools itself."""
    if is_strategy_request(instruction):
        return strategy_plan(instruction, context_findings)
    targets = targets_for(instruction)
    if targets is None:
        targets = list_files(root)
    return format_findings({p: analyze_source((root / p).read_text(encoding="utf-8")) for p in targets})
