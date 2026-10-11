"""D5.4 - A scratchpad file persists key findings across context boundaries.

Two sessions explore the same repo and answer two questions. Between the questions the
context is compacted (what /compact or automatic compaction does in a long session), so
only a short summary of window 1 survives into window 2.

    A  no scratchpad   window 2 sees only the compacted gist -> the answer drifts to "typical patterns"
    B  scratchpad      window 1 writes exact findings to .lab-runtime/scratchpad.md;
                       window 2 reads it first -> the answer cites the specific class, file and constant

Run:  python scratchpad_memory.py          (offline)
      python scratchpad_memory.py --live   (real API; the repo tools stay local and read-only)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from explorer import (  # noqa: E402
    COMPACT_PROMPT,
    EXPLORER_PROMPT,
    EXPLORER_TOOLS,
    SCRATCHPAD,
    SCRATCHPAD_RULES,
    SCRATCHPAD_TOOLS,
    compact_json,
    exchanges,
    reset_runtime,
    run_agent,
    scripted_model,
)

Q1 = "Trace refund flow dependencies starting from the HTTP handler post_refund. Which classes are involved?"
Q2 = "Which class enforces the refund window, in which file, and how many days is it?"


def transcript_of(run: dict[str, Any]) -> str:
    lines = [f"user: {Q1}"]
    lines += [f"tool {name}({compact_json(args)}) ->\n{content}" for name, args, content in exchanges({"messages": run["messages"]})]
    lines.append(f"assistant: {run['answer']}")
    return "\n".join(lines)


def compact(client: Any, transcript: str) -> str:
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=COMPACT_PROMPT,
        messages=[{"role": "user", "content": f"Transcript:\n{transcript}"}],
    )
    return lab.text_of(response)


def session(with_scratchpad: bool) -> dict[str, Any]:
    client = lab.get_client(scripted_model)
    system = EXPLORER_PROMPT + (SCRATCHPAD_RULES if with_scratchpad else "")
    tools = EXPLORER_TOOLS + (SCRATCHPAD_TOOLS if with_scratchpad else [])
    window1 = run_agent(client, system, Q1, tools)
    summary = compact(client, transcript_of(window1))  # the context boundary
    prompt2 = f"Context summary from earlier in this session (after compaction):\n{summary}\n\nQuestion: {Q2}"
    window2 = run_agent(client, system, prompt2, tools)
    return {"window1": window1, "summary": summary, "window2": window2}


def main() -> None:
    lab.banner("D5.4  Scratchpad files counteract context degradation")
    reset_runtime()
    runs = {}
    for key, title, flag in [("A", "A - no scratchpad", False), ("B", "B - scratchpad at .lab-runtime/scratchpad.md", True)]:
        lab.section(title)
        run = session(flag)
        w1, w2 = run["window1"], run["window2"]
        print(f"window 1: {len(w1['calls'])} tool calls, {w1['tool_chars']:,} chars of tool output in context")
        print("  " + "\n  ".join(w1["answer"].split("\n")[:4]) + "\n  ...")
        print(f"compacted summary: {run['summary']}")
        print(f"window 2: tools {w2['calls']}, {w2['tool_chars']:,} chars of tool output")
        print(f"  Q: {Q2}\n  A: {w2['answer']}")
        runs[key] = run

    lab.section("Scratchpad file")
    pad = SCRATCHPAD.read_text(encoding="utf-8") if SCRATCHPAD.exists() else ""
    print(f"{SCRATCHPAD.relative_to(SCRATCHPAD.parents[1]).as_posix()} ({len(pad):,} chars):")
    print("\n".join(pad.split("\n")[:5]) + "\n...")

    lab.section("Checks")
    if lab.is_live():
        print("  live run: answers above come from the real model; offline checks skipped")
        return
    a, b = runs["A"], runs["B"]
    lab.check("ReturnEligibilityGate" in a["window1"]["answer"], "window 1 found the specific class in both sessions")
    lab.check("ReturnEligibilityGate" not in a["summary"], "compaction kept the gist but dropped the exact class names")
    lab.check(
        "Typically" in a["window2"]["answer"] and "ReturnEligibilityGate" not in a["window2"]["answer"],
        "A: after the boundary the answer drifted to a 'typical pattern' (and the wrong window length)",
    )
    lab.check(
        all(s in pad for s in ("ReturnEligibilityGate", "src/policies/eligibility_gate.py", "RETURN_WINDOW_DAYS = 45")),
        "B: the scratchpad holds exact class names, file paths and constants",
    )
    answer = b["window2"]["answer"]
    lab.check(
        b["window2"]["calls"][:1] == ["read_scratchpad"] and "ReturnEligibilityGate" in answer and "45" in answer,
        "B: the new context read the scratchpad first and answered with the specific class and value",
    )
    lab.check(
        b["window2"]["tool_chars"] * 3 < b["window1"]["tool_chars"],
        "B: re-reading the scratchpad cost a fraction of re-exploring the files",
    )


if __name__ == "__main__":
    main()
