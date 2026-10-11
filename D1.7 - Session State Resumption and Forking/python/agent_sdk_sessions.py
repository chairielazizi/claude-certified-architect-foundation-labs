"""D1.7 - The same workflow on the Claude Agent SDK: named session, resume, fork, fresh restart.

    work session 1   query(INVESTIGATE)                                    -> ResultMessage.session_id
                     rename_session(sid, "auth-investigation") + registry   (CLI: claude -n / /rename)
    work session 2   query(change notice, resume=sid)                      -> the same conversation continues
    fork x2          query(strategy, resume=sid, fork_session=True)        -> new ids, original untouched
    work session 3   >50% stale -> query(structured summary), no resume    -> a brand-new session

Live: real Claude Code sessions (Read/Grep/Glob over the workspace; the CLI stores transcripts).
Offline: FakeAgentSessions mimics the SDK's session semantics (new id for a new session or a fork,
same id on resume, a fork copies the transcript) so the orchestration and its checks run without
the CLI. The resume-vs-fresh decisions come from the same registry code as messages_sessions.py.

Run:  python agent_sdk_sessions.py          (offline stand-in for query())
      python agent_sdk_sessions.py --live   (Agent SDK + real Claude; costs tokens)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from investigator import INVESTIGATE, STRATEGIES, offline_answer, parse_findings  # noqa: E402
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

ROOT = RUNTIME / "agent_sdk"
WORKSPACE = ROOT / "workspace"
NAME = "auth-investigation"
SDK_SYSTEM_PROMPT = (
    "You are investigating the auth package in the current directory for security issues. Use Read, Grep "
    "and Glob; never guess file contents. When you finish an analysis, end your reply with one line exactly "
    'like: FINDINGS_JSON: {"auth/file.py": ["finding", ...]} covering every file you read in this turn.'
)

# (prompt, session options) -> (session_id, result text)
Runner = Callable[[str, dict[str, Any]], Awaitable[tuple[str, str]]]


class FakeAgentSessions:
    """Offline stand-in for query() that keeps the SDK's session semantics."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.transcripts: dict[str, list[str]] = {}
        self.count = 0

    def _new_id(self) -> str:
        self.count += 1
        return f"00000000-0000-4000-8000-{self.count:012d}"  # UUID-shaped, like real session ids

    async def run(self, prompt: str, opts: dict[str, Any]) -> tuple[str, str]:
        resume = opts.get("resume")
        if resume and opts.get("fork_session"):
            sid = self._new_id()
            self.transcripts[sid] = list(self.transcripts[resume])  # branch: copy; the original is untouched
        elif resume:
            sid = resume  # the same session continues
        else:
            sid = self._new_id()
            self.transcripts[sid] = []
        context: dict[str, list[str]] = {}
        for earlier in self.transcripts[sid][1::2]:  # assistant results so far
            context.update(parse_findings(earlier))
        answer = offline_answer(self.root, prompt, context)
        self.transcripts[sid] += [prompt, answer]
        return sid, answer


async def run_live(prompt: str, opts: dict[str, Any]) -> tuple[str, str]:
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

    options = ClaudeAgentOptions(
        cwd=str(WORKSPACE),
        system_prompt=SDK_SYSTEM_PROMPT,
        tools=["Read", "Grep", "Glob"],  # read-only investigation
        allowed_tools=["Read", "Grep", "Glob"],
        max_turns=20,
        model=lab.MODEL,
        **opts,  # resume=<id> and/or fork_session=True
    )
    session_id, result = "", ""
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            session_id, result = message.session_id, message.result or ""
    return session_id, result


def name_session(sid: str) -> None:
    """Give the session a human name so `claude --resume auth-investigation` finds it."""
    if lab.is_live():
        from claude_agent_sdk import rename_session

        rename_session(sid, NAME, directory=str(WORKSPACE))
        print(f"  rename_session({sid!r}, {NAME!r}) -> `claude --resume {NAME}` now finds it")
    else:
        print(f"  live would call: rename_session({sid!r}, {NAME!r}, directory=<workspace>)")


def describe(opts: dict[str, Any]) -> str:
    return "ClaudeAgentOptions(" + ", ".join(f"{k}={v!r}" for k, v in opts.items()) + ")"


def snapshot() -> dict[str, str]:
    return hash_files(WORKSPACE, list_files(WORKSPACE))


async def main() -> None:
    lab.banner("D1.7  Named sessions, resume and fork_session with the Agent SDK")
    reset_workspace(WORKSPACE)
    registry = SessionRegistry(ROOT / "sessions.json", reset=True)
    fake = FakeAgentSessions(WORKSPACE)
    run: Runner = run_live if lab.is_live() else fake.run

    lab.section("Work session 1: a named investigation")
    print(f"  query(prompt=INVESTIGATE, options={describe({})})   # no resume: a new session")
    sid, text = await run(INVESTIGATE, {})
    print(f"  ResultMessage.session_id = {sid}")
    name_session(sid)
    registry.save(NAME, sid, snapshot(), parse_findings(text))

    lab.section("Between work sessions: a developer edits auth/tokens.py")
    apply_small_edit(WORKSPACE)

    lab.section("Work session 2: resume the named session")
    entry = registry.get(NAME)
    diff = diff_snapshot(entry["files"], snapshot())
    decision = choose_resume_strategy(diff)
    print(f"  registry: {NAME} -> {entry['session_id']}; decision: {decision['strategy']} ({decision['stale_ratio']:.0%} stale)")
    opts = {"resume": entry["session_id"]}
    print(f"  query(prompt=<change notice>, options={describe(opts)})")
    resumed, text = await run(build_change_message(diff), opts)
    print(f"  session_id = {resumed} (same as before: {resumed == sid})")
    entry = registry.save(NAME, resumed, snapshot(), merge_findings(entry["findings"], parse_findings(text), diff))
    lab.check(decision["strategy"] == "resume", "1 of 4 files changed -> resume with a targeted change notice")
    if not lab.is_live():
        lab.check(resumed == sid, "resume continues the same session id")

    lab.section("Fork: two testing strategies from the shared baseline")
    baseline = list(fake.transcripts.get(resumed, []))
    forks: dict[str, str] = {}
    for label, prompt in STRATEGIES.items():
        opts = {"resume": resumed, "fork_session": True}
        print(f"  query(prompt=<{label}>, options={describe(opts)})")
        fork_id, text = await run(prompt, opts)
        forks[label] = fork_id
        registry.save(f"{NAME}/{label}", fork_id, entry["files"], entry["findings"])
        print(f"    -> new session {fork_id}\n       " + text.replace("\n", "\n       "))
    lab.check(len(set(forks.values()) | {resumed}) == 3, "each fork got its own new session id; the original id is unchanged")
    if not lab.is_live():
        lab.check(fake.transcripts[resumed] == baseline, "forking left the original transcript untouched")
        lab.check(
            all(fake.transcripts[f][: len(baseline)] == baseline for f in forks.values()),
            "both forks start from the shared analysis baseline",
        )

    lab.section("Between work sessions: a refactor touches most of the package")
    apply_refactor(WORKSPACE)

    lab.section("Work session 3: stale context -> fresh session with a structured summary")
    entry = registry.get(NAME)
    diff = diff_snapshot(entry["files"], snapshot())
    decision = choose_resume_strategy(diff)
    print(f"  decision: {decision['strategy']} ({decision['reason']})")
    print(f"  query(prompt=<structured summary>, options={describe({})})   # no resume: a new session")
    fresh, text = await run(build_structured_summary(NAME, entry, diff), {})
    carried = {f: v for f, v in entry["findings"].items() if f in diff["unchanged"]}
    entry = registry.save(NAME, fresh, snapshot(), merge_findings(carried, parse_findings(text), diff))
    print(f"  session_id = {fresh}; {NAME} lineage: {entry['lineage']}")
    lab.check(decision["strategy"] == "fresh", "3 of 4 analysed files stale -> start a new session, not resume")
    lab.check(fresh not in {sid, *forks.values()} and entry["lineage"] == [sid], "the name now points at the fresh session; the old id stays in the lineage")

    lab.section("Registry on disk (.lab-runtime/agent_sdk/sessions.json)")
    for name, e in registry.data.items():
        print(f"  {name:<34} {e['session_id']}  lineage={e['lineage']}")
    print(f"  {json.dumps(entry['findings'])}")


if __name__ == "__main__":
    lab.run(main())
