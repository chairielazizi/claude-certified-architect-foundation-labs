"""D3.6 - Claude Code as a CI reviewer: -p, JSON output, a schema, and no duplicate comments.

    claude -p "<review prompt>"                     non-interactive: run, print, exit (no hang)
           --output-format json                     machine-readable result envelope
           --json-schema "$(cat ci/...schema.json)" validated object lands in .structured_output
           --allowedTools "Read,Grep,Glob,Bash(git diff *)"   what the job may do without a prompt
           --max-turns 12                           bounded run

On a re-run after new commits, the findings already posted on the PR go back into the prompt, so
Claude reports only new or still-unaddressed issues and lists the ones that were fixed. A client-side
reconcile step backs that up, so a re-worded repeat never becomes a second comment.

Run:  python ci_review.py          (offline: fixture CLI results, dry-run GitHub payloads)
      python ci_review.py --live   (runs the real `claude` CLI in example-repo/; still never calls GitHub)
"""

from __future__ import annotations

import json
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

LAB = Path(__file__).resolve().parents[1]
EXAMPLE_REPO = LAB / "example-repo"
FIXTURES = LAB / "fixtures"
SCHEMA_PATH = EXAMPLE_REPO / "ci" / "review-findings.schema.json"
WORKFLOWS = EXAMPLE_REPO / ".github" / "workflows"
ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff *)", "Bash(git log *)"]
MAX_TURNS = 12
MARKER_RE = re.compile(r"<!-- claude-review (\{.*?\}) -->")
STOPWORDS = {"a", "an", "the", "with", "for", "to", "of", "in", "on", "is", "and", "by", "be", "used", "but"}


def review_prompt(base_ref: str, prior: list[dict[str, Any]]) -> str:
    prompt = (
        f"Review the changes in this pull request (git diff origin/{base_ref}...HEAD) against the review "
        "criteria in CLAUDE.md. Report only real problems; use the line number in the new version of each file."
    )
    if prior:
        prompt += (
            "\n\nThese findings were already posted on this pull request by an earlier review:\n"
            + json.dumps(prior, indent=2)
            + "\nReport only issues that are NEW or STILL UNADDRESSED. For a prior issue that still exists, reuse "
            "its id and set status to still_open. Put the ids of prior findings the new commits fixed in "
            "resolved_prior_ids. Do not report anything else twice."
        )
    return prompt


def build_argv(prompt: str, schema_text: str, allowed_tools: list[str] = ALLOWED_TOOLS, max_turns: int = MAX_TURNS) -> list[str]:
    """The exact command line the CI job runs. -p is what keeps it from waiting for terminal input."""
    return [
        "claude", "-p", prompt,
        "--output-format", "json",
        "--json-schema", schema_text,
        "--allowedTools", ",".join(allowed_tools),
        "--max-turns", str(max_turns),
    ]


def display_argv(argv: list[str]) -> str:
    """Shell form for printing: long prompt shortened, schema shown the way the workflow passes it."""
    shown = []
    for i, arg in enumerate(argv):
        if i > 0 and argv[i - 1] == "--json-schema":
            shown.append('"$(cat ci/review-findings.schema.json)"')
        elif i > 0 and argv[i - 1] == "-p":
            shown.append(shlex.quote(arg[:70] + ("..." if len(arg) > 70 else "")))
        else:
            shown.append(shlex.quote(arg))
    return " ".join(shown)


def run_claude(argv: list[str], fixture: Path, cwd: Path = EXAMPLE_REPO) -> dict[str, Any]:
    """Live: run the CLI (stdin closed, timeout). Offline: load a recorded result envelope."""
    if not lab.is_live():
        return json.loads(fixture.read_text(encoding="utf-8"))
    if shutil.which("claude") is None:
        raise SystemExit("The `claude` CLI is not on PATH: npm install -g @anthropic-ai/claude-code")
    proc = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=900, stdin=subprocess.DEVNULL)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr[-500:]}")
    return json.loads(proc.stdout)


def validate(value: Any, schema: dict[str, Any], where: str = "$") -> list[str]:
    """A small JSON Schema subset check (Claude Code already validates; this is defense in depth)."""
    types = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool}
    expected = schema.get("type")
    if expected and (not isinstance(value, types[expected]) or (expected == "integer" and isinstance(value, bool))):
        return [f"{where}: expected {expected}"]
    errors = []
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {value!r} not in {schema['enum']}")
    if expected == "integer" and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{where}: below minimum {schema['minimum']}")
    if expected == "object":
        errors += [f"{where}.{key}: required" for key in schema.get("required", []) if key not in value]
        for key, item in value.items():
            if key in schema.get("properties", {}):
                errors += validate(item, schema["properties"][key], f"{where}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{where}.{key}: not allowed")
    if expected == "array" and "items" in schema:
        for i, item in enumerate(value):
            errors += validate(item, schema["items"], f"{where}[{i}]")
    return errors


# ---------------------------------------------------------------------------
# Prior findings, reconciliation, and GitHub review payloads
# ---------------------------------------------------------------------------


def comment_body(finding: dict[str, Any]) -> str:
    """Inline comment text. The hidden marker lets the next run recover what was already posted."""
    marker = json.dumps({"id": finding["id"], "category": finding["category"], "title": finding["title"]})
    return (
        f"**[{finding['severity']}] {finding['title']}**\n\n{finding['explanation']}\n\n"
        f"Suggestion: {finding['suggestion']}\n\n<!-- claude-review {marker} -->"
    )


def review_payload(head_sha: str, findings: list[dict[str, Any]], body: str) -> dict[str, Any]:
    """Body for POST /repos/{owner}/{repo}/pulls/{number}/reviews (one review, many inline comments)."""
    return {
        "commit_id": head_sha,
        "event": "COMMENT",
        "body": body,
        "comments": [{"path": f["file"], "line": f["line"], "side": "RIGHT", "body": comment_body(f)} for f in findings],
    }


def prior_from_comments(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What GET .../pulls/{number}/comments gives back, reduced to the findings this job posted."""
    prior = []
    for comment in comments:
        match = MARKER_RE.search(comment["body"])
        if match:
            prior.append({**json.loads(match.group(1)), "file": comment["path"], "line": comment["line"]})
    return prior


def title_tokens(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if w not in STOPWORDS}


def same_issue(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Lines shift between commits, so match on file + category + title similarity instead."""
    ta, tb = title_tokens(a["title"]), title_tokens(b["title"])
    return a["file"] == b["file"] and a["category"] == b["category"] and len(ta & tb) / max(1, len(ta | tb)) >= 0.5


@dataclass
class Reconciled:
    to_post: list[dict[str, Any]] = field(default_factory=list)  # genuinely new -> inline comment
    still_open: list[tuple[str, str]] = field(default_factory=list)  # (current id, prior id) -> no new comment
    duplicates: list[tuple[str, str]] = field(default_factory=list)  # reported "new" but already posted
    resolved: list[str] = field(default_factory=list)
    unconfirmed: list[str] = field(default_factory=list)  # prior, neither resolved nor re-reported


def reconcile(output: dict[str, Any], prior: list[dict[str, Any]]) -> Reconciled:
    by_id = {p["id"]: p for p in prior}
    result = Reconciled(resolved=[pid for pid in output["resolved_prior_ids"] if pid in by_id])
    matched: set[str] = set()
    for finding in output["findings"]:
        match = by_id.get(finding["id"]) or next(
            (p for p in prior if p["id"] not in result.resolved and same_issue(finding, p)), None
        )
        if match is None:
            result.to_post.append(finding)
            continue
        matched.add(match["id"])
        result.still_open.append((finding["id"], match["id"]))
        if finding["status"] == "new":
            result.duplicates.append((finding["id"], match["id"]))
    result.unconfirmed = [p["id"] for p in prior if p["id"] not in matched and p["id"] not in result.resolved]
    return result


# ---------------------------------------------------------------------------
# Workflow lint: the YAML in example-repo/.github/workflows does what this lab teaches
# ---------------------------------------------------------------------------


def load_workflow(name: str) -> dict[str, Any]:
    data = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))
    data["on"] = data.get("on", data.pop(True, None))  # YAML 1.1 reads a bare `on:` key as boolean True
    return data


def steps(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    return [step for job in workflow["jobs"].values() for step in job["steps"]]


def lint_workflows() -> None:
    cli = load_workflow("claude-pr-review.yml")
    action = load_workflow("claude-code-action.yml")
    review = next(s for s in steps(cli) if "claude -p" in s.get("run", ""))
    claude_lines = [line.strip() for s in steps(cli) for line in s.get("run", "").splitlines() if line.strip().startswith("claude ")]
    print(f"  claude-pr-review.yml: trigger {list(cli['on'])}, permissions {cli['permissions']}")
    print(f"  claude-code-action.yml: uses {next(s['uses'] for s in steps(action) if 'claude-code-action' in s.get('uses', ''))}")
    lab.check(all(" -p " in f"{line} " for line in claude_lines), "every claude invocation uses -p (sample Q10: otherwise the job hangs on input)")
    lab.check(
        all(flag in review["run"] for flag in ("--output-format json", '--json-schema "$(cat ci/review-findings.schema.json)"', "--allowedTools", "--max-turns")),
        "the CLI step requests JSON output validated against ci/review-findings.schema.json",
    )
    lab.check(review["env"]["ANTHROPIC_API_KEY"] == "${{ secrets.ANTHROPIC_API_KEY }}", "the API key comes from repository secrets, never from the file")
    lab.check(cli["permissions"] == {"contents": "read", "pull-requests": "write"}, "least privilege: read code, write PR comments")
    posting = next(s for s in steps(cli) if "reviews" in s.get("run", ""))
    lab.check('select(.status == "new")' in posting["run"], "only status == new findings become inline comments")
    uses = next(s for s in steps(action) if s.get("uses", "").startswith("anthropics/claude-code-action@"))
    lab.check(
        uses["uses"].endswith("@v1") and uses["with"]["anthropic_api_key"] == "${{ secrets.ANTHROPIC_API_KEY }}" and "--max-turns" in uses["with"]["claude_args"],
        "the alternative workflow uses anthropics/claude-code-action@v1 with the secret and claude_args",
    )


def main() -> None:
    lab.banner("D3.6  Claude Code in CI: -p, --output-format json, --json-schema, dedupe on re-runs")
    schema_text = SCHEMA_PATH.read_text(encoding="utf-8")
    schema = json.loads(schema_text)

    lab.section("Workflow lint (example-repo/.github/workflows)")
    lint_workflows()

    lab.section("Push 1: first review of the pull request")
    argv1 = build_argv(review_prompt("main", []), schema_text)
    print(f"  $ {display_argv(argv1)}")
    result1 = run_claude(argv1, FIXTURES / "review-run-1.json")
    out1 = result1["structured_output"]
    print(f"  result: is_error={result1['is_error']} turns={result1.get('num_turns')} cost=${result1.get('total_cost_usd')}")
    for f in out1["findings"]:
        print(f"    {f['severity']:<9}{f['category']:<14}{f['file']}:{f['line']:<4} {f['title']}")
    payload1 = review_payload("a1b2c3d", out1["findings"], f"Claude review: {out1['summary']}")
    print("  dry run: POST /repos/acme/payments-api/pulls/42/reviews (not sent)")
    print("\n".join("    " + line for line in json.dumps({**payload1, "comments": payload1["comments"][:1]}, indent=2).splitlines()))
    print(f"    ... {len(payload1['comments'])} inline comments in total")
    lab.check(argv1[:2] == ["claude", "-p"] and argv1[argv1.index("--output-format") + 1] == "json", "argv: claude -p ... --output-format json")
    lab.check(argv1[argv1.index("--json-schema") + 1] == schema_text, "--json-schema receives the schema file's contents")
    lab.check(not validate(out1, schema), "structured_output conforms to ci/review-findings.schema.json")
    lab.check(all(set(c) == {"path", "line", "side", "body"} and MARKER_RE.search(c["body"]) for c in payload1["comments"]), "each inline comment has path/line/side/body plus a hidden id marker")

    lab.section("Push 2: the developer fixed some issues; review again")
    posted = [{"path": c["path"], "line": c["line"], "body": c["body"]} for c in payload1["comments"]]  # what GitHub now holds
    prior = prior_from_comments(posted)
    prompt2 = review_prompt("main", prior)
    argv2 = build_argv(prompt2, schema_text)
    print(f"  prior findings recovered from PR comments: {[p['id'] for p in prior]}")
    result2 = run_claude(argv2, FIXTURES / "review-run-2.json")
    out2 = result2["structured_output"]
    rec = reconcile(out2, prior)
    print(f"  resolved by the new commits : {rec.resolved}")
    print(f"  still open (no new comment) : {rec.still_open}")
    print(f"  duplicates suppressed       : {rec.duplicates}")
    print(f"  new -> inline comments      : {[f['id'] for f in rec.to_post]}")
    still = ", ".join(prior_id for _, prior_id in rec.still_open)
    payload2 = review_payload("e4f5a6b", rec.to_post, f"Claude re-review. Resolved: {', '.join(rec.resolved)}. Still open: {still}.")
    print(f"  dry run: POST .../pulls/42/reviews with {len(payload2['comments'])} comment(s); summary: {payload2['body']}")
    lab.check(all(p["id"] in prompt2 for p in prior), "the re-run prompt carries every previously posted finding")
    lab.check(not validate(out2, schema), "push-2 structured_output conforms to the schema too")
    lab.check(sorted(rec.resolved) == ["card-number-logged", "sql-injection-charge-lookup"], "fixed issues are marked resolved, not re-posted")
    lab.check(("float-refund-amount", "float-money-conversion") in rec.duplicates, "a re-worded repeat ('Float arithmetic used for refund amount') is caught client-side")
    lab.check([f["id"] for f in rec.to_post] == ["idempotency-key-not-forwarded"], "only the genuinely new issue becomes a new inline comment")
    lab.check(not rec.unconfirmed, "every prior finding is accounted for (resolved or still open)")


if __name__ == "__main__":
    main()
