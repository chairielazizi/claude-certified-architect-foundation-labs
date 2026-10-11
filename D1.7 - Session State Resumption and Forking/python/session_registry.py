"""A small persistent registry of named investigation sessions, and the resume-vs-fresh decision.

    registry entry   name -> session_id, lineage of earlier ids, content hash of every analysed
                     file at the time of analysis, and the findings per file
    diff             compare stored hashes with the files on disk now: changed / added / deleted
    decide           resume when prior context is mostly valid; start fresh with a structured
                     summary when too many earlier tool results describe code that no longer exists

The registry is what lets a later work session say *which* files changed, so a resumed session
re-reads 1 file instead of re-exploring 4, and a fresh session starts from a summary instead of
stale tool output.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

STALE_THRESHOLD = 0.5  # more than half of the analysed files changed or deleted -> start fresh


def hash_files(root: Path, files: list[str]) -> dict[str, str]:
    return {rel: hashlib.sha256((root / rel).read_bytes()).hexdigest() for rel in files}


def diff_snapshot(old: dict[str, str], new: dict[str, str]) -> dict[str, list[str]]:
    return {
        "changed": sorted(f for f in old if f in new and old[f] != new[f]),
        "added": sorted(f for f in new if f not in old),
        "deleted": sorted(f for f in old if f not in new),
        "unchanged": sorted(f for f in old if f in new and old[f] == new[f]),
    }


def choose_resume_strategy(diff: dict[str, list[str]], threshold: float = STALE_THRESHOLD) -> dict[str, Any]:
    """'resume' when prior context is mostly valid, 'fresh' when tool results are stale."""
    analysed = len(diff["changed"]) + len(diff["deleted"]) + len(diff["unchanged"])
    stale = len(diff["changed"]) + len(diff["deleted"])
    ratio = stale / analysed if analysed else 1.0
    if ratio > threshold:
        return {
            "strategy": "fresh",
            "stale_ratio": ratio,
            "reason": f"{stale}/{analysed} analysed files changed or were deleted ({ratio:.0%} > {threshold:.0%}): "
            "most earlier tool results are stale, so start a new session seeded with a structured summary",
        }
    if stale or diff["added"]:
        return {
            "strategy": "resume",
            "stale_ratio": ratio,
            "reason": f"{stale}/{analysed} analysed files changed ({ratio:.0%}): prior context is mostly valid, "
            "so resume and name the changed files for targeted re-analysis",
        }
    return {"strategy": "resume", "stale_ratio": 0.0, "reason": "nothing changed since the last session: resume as is"}


def build_change_message(diff: dict[str, list[str]]) -> str:
    """The targeted message a resumed session gets instead of 'please look at everything again'."""
    lines = ["Since our last session these files changed:"]
    lines += [f"- {f} (modified)" for f in diff["changed"]]
    lines += [f"- {f} (added)" for f in diff["added"]]
    lines += [f"- {f} (deleted: drop its findings)" for f in diff["deleted"]]
    lines.append(
        "Re-analyze only these files and update your findings for them. "
        "Your earlier analysis of the other files is still valid."
    )
    return "\n".join(lines)


def build_structured_summary(name: str, entry: dict[str, Any], diff: dict[str, list[str]]) -> str:
    """Seed for a fresh session: what still holds, what to re-verify, what to read. No old tool output."""
    findings: dict[str, list[str]] = entry["findings"]
    lines = [f"STRUCTURED SUMMARY of previous session '{name}' ({entry['session_id']}). It replaces that transcript.",
             "Goal: security review of the auth package.",
             "Still-valid findings (file unchanged since it was analysed):"]
    lines += [f"- {f}: {issue}" for f in diff["unchanged"] for issue in findings.get(f, [])] or ["- (none)"]
    lines.append("Findings to re-verify (file changed since it was analysed):")
    lines += [f"- {f}: {issue}" for f in diff["changed"] for issue in findings.get(f, [])] or ["- (none)"]
    lines.append("Dropped (file deleted):")
    lines += [f"- {f}" for f in diff["deleted"]] or ["- (none)"]
    lines.append("Files to re-read:")
    lines += [f"- {f}" for f in diff["changed"]] + [f"- {f} (new)" for f in diff["added"]]
    lines.append("Do not rely on any earlier tool results. Read the files above and report updated findings.")
    return "\n".join(lines)


def merge_findings(old: dict[str, list[str]], new: dict[str, list[str]], diff: dict[str, list[str]]) -> dict[str, list[str]]:
    """Carry findings for files that did not change; take fresh results for the re-read ones."""
    merged = {f: v for f, v in old.items() if f not in diff["deleted"]}
    merged.update(new)
    return dict(sorted(merged.items()))


class SessionRegistry:
    """name -> {session_id, lineage, files (hashes), findings}, persisted as JSON."""

    def __init__(self, path: Path, reset: bool = False) -> None:
        self.path = path
        if reset and path.exists():
            path.unlink()
        self.data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def get(self, name: str) -> dict[str, Any] | None:
        return self.data.get(name)

    def save(self, name: str, session_id: str, files: dict[str, str], findings: dict[str, list[str]]) -> dict[str, Any]:
        previous = self.data.get(name)
        lineage = list(previous["lineage"]) if previous else []
        if previous and previous["session_id"] != session_id:
            lineage.append(previous["session_id"])  # keep the trail of sessions behind this name
        self.data[name] = {"session_id": session_id, "lineage": lineage, "files": files, "findings": findings}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        return self.data[name]
