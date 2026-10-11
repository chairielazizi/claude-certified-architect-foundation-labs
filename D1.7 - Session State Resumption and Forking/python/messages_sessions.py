"""D1.7 - Session state on the plain Messages API: the conversation history IS the session.

    session store   .lab-runtime/messages_api/histories/<id>.json  (the full message list)
    registry        .lab-runtime/messages_api/sessions.json        (name -> id, file hashes, findings)

    work session 1  new named session: list + read every file, record findings and hashes
    (edit 1 file)
    work session 2  resume: reload the history, append "these files changed: ...", re-read only those
    fork            deep-copy the history twice; each branch explores a different testing strategy
    (refactor 3 of 4 files)
    work session 3  >50% stale: start a NEW history seeded with a structured summary, no old tool results

The Agent SDK does the storing for you (agent_sdk_sessions.py); the decisions are the same.

Run:  python messages_sessions.py          (offline, scripted investigator)
      python messages_sessions.py --live   (real Claude API)
"""

from __future__ import annotations

import copy
import json
import shutil
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from investigator import (  # noqa: E402
    INVESTIGATE,
    STRATEGIES,
    SYSTEM_PROMPT,
    TOOLS,
    execute_tool,
    parse_findings,
    scripted_investigator,
)
from session_registry import (  # noqa: E402
    SessionRegistry,
    build_change_message,
    build_structured_summary,
    choose_resume_strategy,
    diff_snapshot,
    hash_files,
    merge_findings,
)
from workspace import RUNTIME, apply_refactor, apply_small_edit, list_files, reset_workspace  # noqa: E402

ROOT = RUNTIME / "messages_api"
WORKSPACE = ROOT / "workspace"
NAME = "auth-investigation"
SAFETY_MAX_ITERATIONS = 20


class HistoryStore:
    """One JSON file per session id. Resume = load + append; fork = deep copy under a new id."""

    def __init__(self, directory: Path) -> None:
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True)
        self.dir = directory
        self.count = 0

    def new_id(self) -> str:
        self.count += 1
        return f"sess-{self.count:03d}"

    def save(self, sid: str, messages: list[dict[str, Any]]) -> None:
        (self.dir / f"{sid}.json").write_text(json.dumps(lab.to_plain(messages), indent=2), encoding="utf-8")

    def load(self, sid: str) -> list[dict[str, Any]]:
        return json.loads((self.dir / f"{sid}.json").read_text(encoding="utf-8"))


def run_turn(client: Any, messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Agentic loop (see D1.1) over the session's history; returns (final text, tool calls made)."""
    calls: list[dict[str, Any]] = []
    for _ in range(SAFETY_MAX_ITERATIONS):
        response = client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=SYSTEM_PROMPT, tools=TOOLS, messages=messages
        )
        # Plain dicts, so the history can be written to disk and reloaded in a later work session.
        messages.append({"role": "assistant", "content": lab.to_plain(response.content)})
        if response.stop_reason == "end_turn":
            return lab.text_of(response), calls
        if response.stop_reason != "tool_use":
            raise RuntimeError(f"Unexpected stop_reason {response.stop_reason!r}")
        results = []
        for block in lab.tool_uses(response):
            content, is_error = execute_tool(WORKSPACE, block.name, block.input)
            calls.append({"name": block.name, "input": lab.to_plain(block.input)})
            result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
            if is_error:
                result["is_error"] = True
            results.append(result)
        messages.append({"role": "user", "content": results})
    raise RuntimeError(f"Turn did not finish in {SAFETY_MAX_ITERATIONS} iterations")


def reads(calls: list[dict[str, Any]]) -> list[str]:
    return [c["input"]["path"] for c in calls if c["name"] == "read_file"]


def tool_results_in(messages: list[dict[str, Any]]) -> int:
    return sum(1 for m in messages if m["role"] == "user" and not isinstance(m["content"], str) for b in m["content"] if b["type"] == "tool_result")


def show_findings(findings: dict[str, list[str]]) -> None:
    for path, issues in findings.items():
        print(f"    {path}: {'; '.join(issues) if issues else 'no issues'}")


def main() -> None:
    lab.banner("D1.7  Resume, fork and fresh start with the Messages API (history = session)")
    reset_workspace(WORKSPACE)
    store = HistoryStore(ROOT / "histories")
    registry = SessionRegistry(ROOT / "sessions.json", reset=True)
    client = lab.get_client(scripted_investigator)

    lab.section("Work session 1: start the named investigation")
    sid = store.new_id()
    history: list[dict[str, Any]] = [{"role": "user", "content": INVESTIGATE}]
    answer, calls = run_turn(client, history)
    store.save(sid, history)
    entry = registry.save(NAME, sid, hash_files(WORKSPACE, list_files(WORKSPACE)), parse_findings(answer))
    session1 = copy.deepcopy(history)
    print(f"  {NAME} -> {sid}; read {reads(calls)}")
    show_findings(entry["findings"])
    lab.check(sorted(reads(calls)) == list_files(WORKSPACE), "session 1 explored every file")
    lab.check(len(entry["files"]) == 4 and entry["findings"] != {}, "registry stored 4 content hashes and the findings under the session name")

    lab.section("Between work sessions: a developer edits auth/tokens.py")
    apply_small_edit(WORKSPACE)

    lab.section("Work session 2: resume by name with a targeted change notice")
    entry = registry.get(NAME)
    diff = diff_snapshot(entry["files"], hash_files(WORKSPACE, list_files(WORKSPACE)))
    decision = choose_resume_strategy(diff)
    print(f"  diff: {json.dumps({k: v for k, v in diff.items() if v})}")
    print(f"  decision: {decision['strategy']} ({decision['reason']})")
    history = store.load(entry["session_id"])  # resume = continue the stored conversation
    notice = build_change_message(diff)
    print("  " + notice.replace("\n", "\n  "))
    history.append({"role": "user", "content": notice})
    answer, calls = run_turn(client, history)
    store.save(sid, history)
    findings = merge_findings(entry["findings"], parse_findings(answer), diff)
    entry = registry.save(NAME, sid, hash_files(WORKSPACE, list_files(WORKSPACE)), findings)
    print(f"  re-read: {reads(calls)}")
    show_findings(findings)
    lab.check(decision["strategy"] == "resume", "1 of 4 files changed -> resume (prior context mostly valid)")
    lab.check(history[: len(session1)] == session1, "the resumed session still holds the full session-1 history")
    if not lab.is_live():
        lab.check(reads(calls) == ["auth/tokens.py"], "targeted re-analysis: only the changed file was re-read")
        lab.check(findings["auth/tokens.py"] == ["signing secret is hard-coded in source"], "tokens.py: 'never expire' resolved, hard-coded secret still open")

    lab.section("Fork: two testing strategies from the shared analysis baseline")
    baseline = store.load(sid)
    branches: dict[str, tuple[str, list[dict[str, Any]], str]] = {}
    for label, prompt in STRATEGIES.items():
        fork_id = store.new_id()
        branch = copy.deepcopy(baseline)  # independent copy of the whole history
        branch.append({"role": "user", "content": prompt})
        answer, _ = run_turn(client, branch)
        store.save(fork_id, branch)
        registry.save(f"{NAME}/{label}", fork_id, entry["files"], entry["findings"])
        branches[label] = (fork_id, branch, answer)
        print(f"  {label} -> {fork_id} (forked from {sid})\n    " + answer.replace("\n", "\n    "))
    (id_a, a, ans_a), (id_b, b, ans_b) = branches.values()
    n = len(baseline)
    lab.check(a[:n] == baseline and b[:n] == baseline, f"both branches share the {n}-message baseline prefix")
    lab.check(a[n:] != b[n:] and ans_a != ans_b and id_a != id_b, "the branches diverge after the baseline")
    lab.check(len(store.load(sid)) == n, "forking did not modify the original session")
    a[0]["content"] += " (edited in branch A)"
    lab.check(b[0]["content"] == baseline[0]["content"] == INVESTIGATE, "branches are independent: an edit in A does not leak into B or the baseline")
    shallow = list(baseline)
    shallow[0]["content"] += " (edited)"
    lab.check(baseline[0]["content"] != INVESTIGATE, "contrast: a shallow copy shares message objects, so the edit leaked into the baseline")

    lab.section("Between work sessions: a refactor touches most of the package")
    apply_refactor(WORKSPACE)

    lab.section("Work session 3: resume or start fresh?")
    entry = registry.get(NAME)
    diff = diff_snapshot(entry["files"], hash_files(WORKSPACE, list_files(WORKSPACE)))
    decision = choose_resume_strategy(diff)
    print(f"  diff: {json.dumps({k: v for k, v in diff.items() if v})}")
    print(f"  decision: {decision['strategy']} ({decision['reason']})")
    summary = build_structured_summary(NAME, entry, diff)
    print("  " + summary.replace("\n", "\n  "))
    new_sid = store.new_id()
    history = [{"role": "user", "content": summary}]  # NEW history: no stale tool results carried over
    answer, calls = run_turn(client, history)
    store.save(new_sid, history)
    carried = {f: v for f, v in entry["findings"].items() if f in diff["unchanged"]}
    findings = merge_findings(carried, parse_findings(answer), diff)
    entry = registry.save(NAME, new_sid, hash_files(WORKSPACE, list_files(WORKSPACE)), findings)
    print(f"  {NAME} -> {new_sid} (lineage {entry['lineage']}); re-read {reads(calls)}")
    show_findings(findings)
    lab.check(decision["strategy"] == "fresh", "3 of 4 analysed files changed or deleted -> start fresh")
    lab.check(tool_results_in(history) == len(calls), "the fresh session holds only its own tool results, none from earlier sessions")
    lab.check("auth/tokens.py: signing secret is hard-coded" in summary and "- auth/middleware.py" in summary, "summary carries still-valid findings and lists the deleted file")
    lab.check(entry["session_id"] == new_sid and entry["lineage"] == [sid], "the name now points at the new session; the old id is kept in its lineage")
    if not lab.is_live():
        lab.check(sorted(reads(calls)) == ["auth/login.py", "auth/oauth.py", "auth/session.py"], "only the changed and added files were read")
        lab.check(any("verify=False" in i for i in findings["auth/oauth.py"]), "the fresh session found the new issue in oauth.py")

    lab.section("choose_resume_strategy boundaries")
    half = {"changed": ["a", "b"], "added": [], "deleted": [], "unchanged": ["c", "d"]}
    most = {"changed": ["a", "b"], "added": [], "deleted": ["c"], "unchanged": ["d"]}
    none = {"changed": [], "added": [], "deleted": [], "unchanged": ["a", "b"]}
    for label, d in (("2/4 changed", half), ("3/4 changed or deleted", most), ("nothing changed", none)):
        print(f"  {label:<24} -> {choose_resume_strategy(d)['strategy']}")
    lab.check(choose_resume_strategy(half)["strategy"] == "resume", "exactly 50% stale still resumes (threshold is > 50%)")
    lab.check(choose_resume_strategy(most)["strategy"] == "fresh" and choose_resume_strategy(none)["strategy"] == "resume", "75% stale -> fresh; nothing changed -> resume")


if __name__ == "__main__":
    main()
