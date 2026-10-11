"""Codebase-exploration toolkit shared by the D5.4 demos.

* Read-only tools over the fixture repo (``fixtures/shop-repo``): glob, grep, read_file.
* Scratchpad tools that persist findings to ``.lab-runtime/scratchpad.md``.
* A generic agent loop that measures how many characters of tool output land in context.
* Scripted stand-ins for Claude. The explorer is model-driven: it traces a flow by reading
  a file, parsing its imports and reading what they point to next, and it builds its
  findings from the file contents it has actually seen in the conversation.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

LAB_DIR = Path(__file__).resolve().parents[1]
REPO = LAB_DIR / "fixtures" / "shop-repo"
RUNTIME = LAB_DIR / ".lab-runtime"
SCRATCHPAD = RUNTIME / "scratchpad.md"


def reset_runtime() -> None:
    """Fresh .lab-runtime/ for every run so reruns are deterministic."""
    shutil.rmtree(RUNTIME, ignore_errors=True)
    RUNTIME.mkdir(parents=True)


# ---------------------------------------------------------------------------
# Read-only repo tools (Glob / Grep / Read equivalents)
# ---------------------------------------------------------------------------


def list_files() -> list[str]:
    return sorted(p.relative_to(REPO).as_posix() for p in REPO.rglob("*") if p.is_file())


def glob_to_regex(pattern: str) -> str:
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + ("\\" + pattern[i] if pattern[i] in ".+^$()[]{}|\\" else pattern[i]), i + 1
    return "^" + out + "$"


def read_text(path: str) -> str:
    return (REPO / path).read_text(encoding="utf-8").replace("\r\n", "\n")


def tool_glob(pattern: str) -> str:
    regex = re.compile(glob_to_regex(pattern))
    return "\n".join(f for f in list_files() if regex.match(f)) or "(no matches)"


def tool_grep(pattern: str, path: str = "") -> str:
    regex = re.compile(pattern)
    prefix = path.rstrip("/") + "/" if path else ""
    hits = []
    for f in list_files():
        if f.startswith(prefix):
            for n, line in enumerate(read_text(f).split("\n"), 1):
                if regex.search(line):
                    hits.append(f"{f}:{n}: {line.strip()}")
    return "\n".join(hits) or "(no matches)"


def tool_read(path: str) -> tuple[str, bool]:
    if path not in list_files():
        return f"error: no file {path}", True
    return read_text(path), False


EXPLORER_TOOLS: list[dict[str, Any]] = [
    {
        "name": "glob",
        "description": "List repository files matching a glob pattern, e.g. 'tests/**/*.py'.",
        "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]},
    },
    {
        "name": "grep",
        "description": "Search file contents with a regular expression. Optional path prefix, e.g. 'src'. Returns path:line: text.",
        "input_schema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}},
            "required": ["pattern"],
        },
    },
    {
        "name": "read_file",
        "description": "Read one file by its repository-relative path.",
        "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
]

SCRATCHPAD_TOOLS: list[dict[str, Any]] = [
    {
        "name": "append_scratchpad",
        "description": "Append key findings (exact class names, file paths, constants, call order) to the persistent scratchpad file.",
        "input_schema": {"type": "object", "properties": {"notes": {"type": "string"}}, "required": ["notes"]},
    },
    {
        "name": "read_scratchpad",
        "description": "Read the persistent scratchpad of findings recorded earlier in this session, including before any context reset.",
        "input_schema": {"type": "object", "properties": {}},
    },
]


def execute(name: str, args: dict[str, Any]) -> tuple[str, bool]:
    if name == "glob":
        return tool_glob(args["pattern"]), False
    if name == "grep":
        return tool_grep(args["pattern"], args.get("path", "")), False
    if name == "read_file":
        return tool_read(args["path"])
    if name == "append_scratchpad":
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with SCRATCHPAD.open("a", encoding="utf-8") as fh:
            fh.write(args["notes"].rstrip("\n") + "\n\n")
        return f"ok: scratchpad is now {len(SCRATCHPAD.read_text(encoding='utf-8'))} chars", False
    if name == "read_scratchpad":
        return (SCRATCHPAD.read_text(encoding="utf-8") if SCRATCHPAD.exists() else "(scratchpad is empty)"), False
    return f"error: unknown tool {name}", True


# ---------------------------------------------------------------------------
# A generic agent loop that measures context growth
# ---------------------------------------------------------------------------

Executor = Callable[[str, dict[str, Any]], tuple[str, bool]]
SAFETY_MAX_ITERATIONS = 30


def run_agent(
    client: Any,
    system: str,
    prompt: str,
    tools: list[dict[str, Any]],
    executor: Executor = execute,
    on_tool_result: Callable[[str, dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    calls: list[str] = []
    tool_chars = 0
    for _ in range(SAFETY_MAX_ITERATIONS):
        params: dict[str, Any] = {"model": lab.MODEL, "max_tokens": 16000, "system": system, "messages": list(messages)}
        if tools:
            params["tools"] = tools
        response = client.messages.create(**params)
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return {"answer": lab.text_of(response), "calls": calls, "tool_chars": tool_chars, "messages": messages}
        results = []
        for block in lab.tool_uses(response):
            args = dict(block.input)
            content, is_error = executor(block.name, args)
            calls.append(block.name)
            tool_chars += len(content)  # everything a tool returns stays in THIS agent's context
            result = {"type": "tool_result", "tool_use_id": block.id, "content": content}
            if is_error:
                result["is_error"] = True
            results.append(result)
            if on_tool_result:
                on_tool_result(block.name, args)
        messages.append({"role": "user", "content": results})
    raise RuntimeError("agent did not finish")


# ---------------------------------------------------------------------------
# Digests: what a careful explorer writes down about a file
# ---------------------------------------------------------------------------

CLASS_RE = re.compile(r"^class (\w+)")
DEF_RE = re.compile(r"^def (\w+)")
METHOD_RE = re.compile(r"^    def (\w+)\(")
CONST_RE = re.compile(r"^([A-Z][A-Z0-9_]{2,}) = (.+?)(\s+#.*)?$", re.M)
ATTR_RE = re.compile(r"self\.(\w+) = (\w+)\(")
SELF_CALL_RE = re.compile(r"self\.(\w+)\.(\w+)\(")
DIRECT_CALL_RE = re.compile(r"\b([A-Z]\w+)\(\)\.(\w+)\(")
IMPORT_RE = re.compile(r"^from src\.([\w.]+) import ([\w, ]+)$", re.M)
TEST_RE = re.compile(r"^def test_", re.M)


def file_digest(path: str, content: str) -> str:
    """One line per file: top-level defs/classes (with methods), constants, and outgoing calls."""
    defs: list[dict[str, Any]] = []
    for line in content.split("\n"):
        cls, fn, method = CLASS_RE.match(line), DEF_RE.match(line), METHOD_RE.match(line)
        if cls:
            defs.append({"kind": "class", "name": cls.group(1), "methods": []})
        elif fn:
            defs.append({"kind": "def", "name": fn.group(1), "methods": []})
        elif method and defs and defs[-1]["kind"] == "class" and not method.group(1).startswith("__"):
            defs[-1]["methods"].append(method.group(1))
    rendered = [f"{d['kind']} {d['name']}" + (f" [{', '.join(d['methods'])}]" if d["methods"] else "") for d in defs]
    consts = [f"{m.group(1)} = {m.group(2)}" for m in CONST_RE.finditer(content)]
    attrs = {m.group(1): m.group(2) for m in ATTR_RE.finditer(content)}
    calls = [f"{m.group(1)}.{m.group(2)}" for m in DIRECT_CALL_RE.finditer(content)]
    calls += [f"{attrs[m.group(1)]}.{m.group(2)}" for m in SELF_CALL_RE.finditer(content) if m.group(1) in attrs]
    line = f"- {path}: " + ", ".join(rendered)
    if consts:
        line += "; " + ", ".join(consts)
    if calls:
        line += "; calls " + " -> ".join(calls)
    return line


def test_digest(path: str, content: str) -> str:
    targets = [name.strip() for m in IMPORT_RE.finditer(content) for name in m.group(2).split(",")]
    return f"- {path}: {len(TEST_RE.findall(content))} test(s), targets {', '.join(targets)}"


def imports_of(content: str) -> list[str]:
    return ["src/" + m.group(1).replace(".", "/") + ".py" for m in IMPORT_RE.finditer(content)]


# ---------------------------------------------------------------------------
# Reading the conversation (what the scripted models "see")
# ---------------------------------------------------------------------------


def _get(block: Any, name: str) -> Any:
    return block.get(name) if isinstance(block, dict) else getattr(block, name, None)


def exchanges(params: dict[str, Any]) -> list[tuple[str, dict[str, Any], str]]:
    """(tool name, input, result content) for every tool call so far, in order."""
    pending: dict[str, tuple[str, dict[str, Any]]] = {}
    out = []
    for msg in params["messages"]:
        if isinstance(msg["content"], str):
            continue
        for block in msg["content"]:
            if _get(block, "type") == "tool_use":
                pending[_get(block, "id")] = (_get(block, "name"), dict(_get(block, "input")))
            elif _get(block, "type") == "tool_result" and _get(block, "tool_use_id") in pending:
                name, args = pending[_get(block, "tool_use_id")]
                out.append((name, args, _get(block, "content")))
    return out


def first_prompt(params: dict[str, Any]) -> str:
    return params["messages"][0]["content"]


def tool_names(params: dict[str, Any]) -> list[str]:
    return [t["name"] for t in params.get("tools", [])]


# ---------------------------------------------------------------------------
# Scripted explorer
# ---------------------------------------------------------------------------

EXPLORER_PROMPT = (
    "You are a codebase explorer working in a read-only repository. Use glob, grep and read_file to "
    "answer from the actual code. Report exact class names, file paths and constants, never typical patterns."
)
SCRATCHPAD_RULES = (
    " Record key findings (exact class names, file paths, constants, call order) with append_scratchpad "
    "before you answer. At the start of a new context, call read_scratchpad before answering anything."
)
TRACES = {"trace refund flow": ("Refund flow", "def post_refund"), "trace notification": ("Notification flow", "class RefundNotifier")}
TEST_TASK = "find all test files"


def _test_phase(seen: list[tuple[str, dict[str, Any], str]]) -> tuple[lab.Obj | None, str | None]:
    globs = [c for n, a, c in seen if n == "glob" and a["pattern"].startswith("tests")]
    if not globs:
        return lab.message(lab.tool_use("glob", {"pattern": "tests/**/*.py"})), None
    reads = {a["path"]: c for n, a, c in seen if n == "read_file"}
    listed = globs[0].split("\n")
    for path in listed:
        if path not in reads:
            return lab.message(lab.tool_use("read_file", {"path": path})), None
    lines = [test_digest(p, reads[p]) for p in listed]
    return None, f"Test files ({len(listed)} found by glob 'tests/**/*.py'):\n" + "\n".join(lines)


def _trace_phase(seen: list[tuple[str, dict[str, Any], str]], label: str, start: str) -> tuple[lab.Obj | None, str | None]:
    greps = [c for n, a, c in seen if n == "grep" and a["pattern"] == start]
    if not greps:
        return lab.message(lab.tool_use("grep", {"pattern": start, "path": "src"})), None
    reads = {a["path"]: c for n, a, c in seen if n == "read_file"}
    order = [greps[0].split(":", 1)[0]]
    i = 0
    while i < len(order):  # breadth-first over imports of the files read so far
        if order[i] in reads:
            order += [p for p in imports_of(reads[order[i]]) if p not in order]
        i += 1
    for path in order:
        if path not in reads:
            return lab.message(lab.tool_use("read_file", {"path": path})), None
    lines = [file_digest(p, reads[p]) for p in order]
    return None, f"{label} traced from '{start}' ({len(order)} files read):\n" + "\n".join(lines)


WINDOW_LINE_RE = re.compile(r"^- (\S+): ([^\n]*)RETURN_WINDOW_DAYS = (\d+)", re.M)


def _window_answer(visible: str) -> str:
    match = WINDOW_LINE_RE.search(visible)
    if not match:
        # Nothing specific in context: this is the drift the exam describes.
        return "Typically a RefundPolicy class in the service layer enforces the refund window, usually 30 days."
    path, defs, days = match.groups()
    gate = next(m.group(1) for m in re.finditer(r"class (\w+) \[", defs))
    return f"{gate} in {path} enforces it: RETURN_WINDOW_DAYS = {days} (days since delivery)."


def scripted_explorer(params: dict[str, Any]) -> lab.Obj:
    task = first_prompt(params)
    lowered = task.split("\n", 1)[0].lower()  # the task is the first line; anything below is context
    seen = exchanges(params)
    names = [n for n, _, _ in seen]
    has_scratchpad = "append_scratchpad" in tool_names(params)

    if "Question:" in task:  # a follow-up question in a new context window
        if "read_scratchpad" in tool_names(params) and "read_scratchpad" not in names:
            return lab.message(lab.text("New context: checking my scratchpad first."), lab.tool_use("read_scratchpad", {}))
        visible = task + "\n" + "\n".join(c for _, _, c in seen)
        return lab.message(lab.text(_window_answer(visible)))

    summaries = []
    if TEST_TASK in lowered:
        action, summary = _test_phase(seen)
        if action:
            return action
        summaries.append(summary)
    for key, (label, start) in TRACES.items():
        if key in lowered:
            action, summary = _trace_phase(seen, label, start)
            if action:
                return action
            summaries.append(summary)
    notes = "\n\n".join(s for s in summaries if s)
    if has_scratchpad and "append_scratchpad" not in names:
        return lab.message(lab.text("Recording findings before answering."), lab.tool_use("append_scratchpad", {"notes": notes}))
    return lab.message(lab.text(notes))


# ---------------------------------------------------------------------------
# Scripted analyst (phase 2) and reviewer (crash-recovery demo)
# ---------------------------------------------------------------------------

ANALYST_PROMPT = (
    "You are a test-gap analyst. Use the tools only for what the provided findings do not already tell you. "
    "Propose missing test cases with exact values."
)
REVIEWER_PROMPT = "You review exploration findings for risky couplings. Use only the findings you are given and cite class names."
GATE_LINE_RE = re.compile(r"^- (src/\S+\.py): [^\n]*RETURN_WINDOW_DAYS", re.M)
GATE_TEST_RE = re.compile(r"^- (tests/\S+\.py): [^\n]*targets [^\n]*ReturnEligibilityGate", re.M)


def scripted_analyst(params: dict[str, Any]) -> lab.Obj:
    prompt = first_prompt(params)
    seen = exchanges(params)
    reads = {a["path"]: c for n, a, c in seen if n == "read_file"}
    gate = GATE_LINE_RE.search(prompt)
    gate_path = gate.group(1) if gate else None
    if gate_path is None:
        greps = [c for n, _, c in seen if n == "grep"]
        if not greps:
            return lab.message(lab.tool_use("grep", {"pattern": "RETURN_WINDOW_DAYS =", "path": "src"}))
        gate_path = greps[0].split(":", 1)[0]
    if gate_path not in reads:
        return lab.message(lab.tool_use("read_file", {"path": gate_path}))
    test = GATE_TEST_RE.search(prompt)
    test_path = test.group(1) if test else next((p for p, c in reads.items() if p.startswith("tests/") and "ReturnEligibilityGate" in c), None)
    if test_path is None:
        globs = [c for n, _, c in seen if n == "glob"]
        if not globs:
            return lab.message(lab.tool_use("glob", {"pattern": "tests/**/*.py"}))
        unread = [p for p in globs[0].split("\n") if p not in reads]
        return lab.message(lab.tool_use("read_file", {"path": unread[0]}))
    if test_path not in reads:
        return lab.message(lab.tool_use("read_file", {"path": test_path}))

    code, tests = reads[gate_path], reads[test_path]
    window = int(re.search(r"RETURN_WINDOW_DAYS = (\d+)", code).group(1))  # type: ignore[union-attr]
    strict = bool(re.search(r"days > RETURN_WINDOW_DAYS", code))
    covered = sorted({int(d) for d in re.findall(r"days_ago=(\d+)", tests)})
    proposals = []
    if window not in covered:
        proposals.append(f"days_ago={window} is {'accepted' if strict else 'rejected'} (the boundary itself)")
    if window + 1 not in covered:
        proposals.append(f"days_ago={window + 1} raises WindowExpired")
    if "NotDelivered" in code and "NotDelivered" not in tests:
        proposals.append("delivered_on=None raises NotDelivered")
    text = f"Missing tests for ReturnEligibilityGate (RETURN_WINDOW_DAYS = {window}; existing tests use days_ago={covered}):\n"
    return lab.message(lab.text(text + "\n".join(f"{i}. {p}" for i, p in enumerate(proposals, 1))))


def scripted_reviewer(params: dict[str, Any]) -> lab.Obj:
    findings = first_prompt(params)
    risks = []
    if re.search(r"AcmePayClient\.refund -> LedgerJournal\.record", findings):
        risks.append("CreditReversalService calls AcmePayClient.refund before LedgerJournal.record: a ledger failure leaves money refunded but unrecorded.")
    if "MAX_RETRIES = 0" in findings and "RefundNotifier" in findings:
        risks.append("RefundNotifier sends through EmailGateway with MAX_RETRIES = 0: a failed confirmation email is silently dropped after the refund.")
    if "Test files" in findings and "targets RefundNotifier" not in findings:
        risks.append("No test file targets RefundNotifier, so the notification step is untested.")
    if not risks:
        return lab.message(lab.text("No findings from earlier agents were provided, so I cannot assess couplings."))
    return lab.message(lab.text("Risky couplings:\n" + "\n".join(f"- {r}" for r in risks)))


COMPACT_PROMPT = "Summarize this exploration session briefly so the work can continue in a fresh context."
PATH_RE = re.compile(r"\bsrc/(\w+)/\w+\.py\b")


def scripted_compactor(params: dict[str, Any]) -> lab.Obj:
    """Keeps the gist and drops the exact names: the way detail erodes when context is compacted."""
    transcript = lab.last_user_text(params)
    files = sorted(set(m.group(0) for m in PATH_RE.finditer(transcript)))
    areas = sorted(set(m.group(1) for m in PATH_RE.finditer(transcript)))
    return lab.message(lab.text(
        f"Explored {len(files)} source files ({', '.join(areas)}) and answered how refunds flow through the code. "
        "A request goes from the API handler to a refund service, which checks a return policy, calls the "
        "payment provider, writes the ledger and notifies the customer."
    ))


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    """One responder for every role; the system prompt says which role this call is."""
    system = lab.system_text(params)
    if system.startswith(COMPACT_PROMPT):
        return scripted_compactor(params)
    if system.startswith(ANALYST_PROMPT):
        return scripted_analyst(params)
    if system.startswith(REVIEWER_PROMPT):
        return scripted_reviewer(params)
    return scripted_explorer(params)


def compact_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))
