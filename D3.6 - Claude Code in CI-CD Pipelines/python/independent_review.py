"""D3.6 - The reviewer must be an independent Claude Code invocation, not the generator's session.

The session that wrote the code carries its own reasoning: "float is fine for two decimals",
"refunds are rare, compare each one with the charge". Asking that same session to review
(`claude -p --resume <generator-session> "review your changes"`) mostly confirms those assumptions.
A fresh `claude -p` run starts with no history: it reads the diff and CLAUDE.md's review criteria
and judges the code on its own. --fork-session does not help, because a fork copies the history.

Always offline: it compares recorded CLI results; the command lines are the same ones ci_review.py runs live.

Run:  python independent_review.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from ci_review import FIXTURES, SCHEMA_PATH, build_argv, display_argv, review_prompt  # noqa: E402

CONTEXT_REUSE_FLAGS = ("--resume", "-r", "--continue", "-c", "--fork-session")


def self_review_argv(generator_session: str, schema_text: str, fork: bool = False) -> list[str]:
    """The anti-pattern: continue (or fork) the generator's conversation and ask it to review itself."""
    argv = ["claude", "-p", "--resume", generator_session, "Review the changes you just made for bugs."]
    if fork:
        argv.append("--fork-session")
    return argv + ["--output-format", "json", "--json-schema", schema_text]


def is_independent(argv: list[str], generator_session: str) -> tuple[bool, list[str]]:
    """An independent reviewer reuses nothing from the generator's session."""
    problems = [f"{flag} reuses an earlier conversation" for flag in CONTEXT_REUSE_FLAGS if flag in argv]
    if generator_session in argv:
        problems.append("references the generator's session id")
    return not problems, problems


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def main() -> None:
    lab.banner("D3.6  Independent review: a fresh claude -p run, not the generator's session")
    schema_text = SCHEMA_PATH.read_text(encoding="utf-8")
    generator = load("generator-run.json")
    session = generator["session_id"]
    print(f"  generator session {session} said:\n    {generator['result']}")

    lab.section("Anti-pattern: the generator reviews its own work")
    same = self_review_argv(session, schema_text)
    forked = self_review_argv(session, schema_text, fork=True)
    print(f"  $ {display_argv(same)}")
    self_result = load("self-review-run.json")
    self_findings = self_result["structured_output"]["findings"]
    print(f"  -> session {self_result['session_id']}: {self_result['result']}")
    print(f"     findings: {[(f['severity'], f['title']) for f in self_findings]}")

    lab.section("Independent reviewer: a separate invocation with no history")
    fresh = build_argv(review_prompt("main", []), schema_text)
    print(f"  $ {display_argv(fresh)}")
    review = load("review-run-1.json")
    findings = review["structured_output"]["findings"]
    print(f"  -> session {review['session_id']}")
    for f in findings:
        print(f"     {f['severity']:<9}{f['title']}")

    lab.section("Checks")
    ok_same, why_same = is_independent(same, session)
    ok_fork, why_fork = is_independent(forked, session)
    ok_fresh, _ = is_independent(fresh, session)
    print(f"  self-review problems: {why_same}\n  forked self-review problems: {why_fork}")
    lab.check(not ok_same, "--resume <generator session> is not an independent review")
    lab.check(not ok_fork, "--fork-session is not independent either: a fork starts from a copy of the history")
    lab.check(ok_fresh, "the CI reviewer argv has no --resume / --continue / --fork-session")
    lab.check(self_result["session_id"] == session and review["session_id"] != session, "the self-review continued the generator's session; the independent one has its own")
    critical = lambda fs: sum(f["severity"] == "critical" for f in fs)  # noqa: E731
    lab.check(critical(findings) == 3 and critical(self_findings) == 0, "the independent reviewer found the 3 critical issues the self-review rationalized away")


if __name__ == "__main__":
    main()
