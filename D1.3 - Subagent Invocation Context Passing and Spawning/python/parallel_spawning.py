"""D1.3 - Parallel subagent spawning: several Agent calls in ONE coordinator response.

Simulated at the Messages API level so the timing is visible. The coordinator has one tool,
"Agent" (same input shape as the Agent SDK's spawning tool), and the executor runs every Agent
tool_use block of a turn as a separate subagent call with a fresh, one-message context.

  A  parallel prompt, concurrent executor: one turn with 4 Agent calls -> asyncio.gather
  B  the same turn executed one call after another (the executor matters too)
  C  anti-pattern: the coordinator emits one Agent call per turn, across separate turns

Every model call carries 0.3 s of simulated latency (lab.get_async_client(..., latency_s=0.3)).

Run:  python parallel_spawning.py          (offline, simulated latency)
      python parallel_spawning.py --live   (real API; timings then depend on the model)
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from agent_definitions import AGENT_SPECS, COORDINATOR_PROMPT, PARALLEL_SENTENCE, TOPIC, is_delegation  # noqa: E402
from context_passing import FINDINGS, scripted_synthesizer, structured_handoff  # noqa: E402

LATENCY_S = 0.3
SAFETY_MAX_TURNS = 12

# The spawning tool, as a Messages API tool definition.
AGENT_TOOL: dict[str, Any] = {
    "name": "Agent",
    "description": (
        "Spawn a subagent with a fresh, empty context. subagent_type selects its definition; prompt must "
        "contain everything the subagent needs. Several Agent calls in one response run in parallel."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "subagent_type": {"type": "string", "enum": list(AGENT_SPECS)},
            "description": {"type": "string", "description": "3-5 word label for the task"},
            "prompt": {"type": "string", "description": "The complete task for the subagent"},
        },
        "required": ["subagent_type", "description", "prompt"],
    },
}

# The anti-pattern prompt: same goals, but it tells the coordinator to serialise delegation.
SERIAL_SENTENCE = "Delegate one task at a time and wait for each result before starting the next."
ONE_AT_A_TIME_PROMPT = COORDINATOR_PROMPT.replace(PARALLEL_SENTENCE, SERIAL_SENTENCE)

# Four independent research tasks: none needs another's output, so they can all run at once.
RESEARCH_TASKS = [
    {"subagent_type": "web-researcher", "description": "Music licensing news",
     "prompt": "Find 2026 news about record labels licensing catalogues to AI music companies."},
    {"subagent_type": "doc-analyst", "description": "Music rights report",
     "prompt": "From ./docs/music_rights_review_2026.md extract findings on AI-training licence income in music."},
    {"subagent_type": "web-researcher", "description": "VFX adoption news",
     "prompt": "Find 2026 news or surveys on how many VFX studios use generative AI."},
    {"subagent_type": "doc-analyst", "description": "VFX workforce study",
     "prompt": "From ./docs/screen_vfx_workforce_study_2026.md extract findings on generative AI adoption in VFX studios."},
]
SYNTHESIS_LABEL = "Synthesize briefing"


# ---------------------------------------------------------------------------
# Offline stand-ins: one responder plays the coordinator and every subagent
# ---------------------------------------------------------------------------


def scripted_subagent(name: str, params: dict[str, Any]) -> lab.Obj:
    if name == "synthesizer":
        return scripted_synthesizer(params)
    task = lab.last_user_text(params).lower()
    subject = "music" if "music" in task else "vfx"
    hits = [f for f in FINDINGS if f["agent"] == name and subject in f["content"]["claim"].lower()]
    return lab.message(lab.text(json.dumps(hits)))


def scripted_coordinator(params: dict[str, Any]) -> lab.Obj:
    """Decides from the conversation: what has been spawned, what came back, what the prompt asks."""
    messages = params["messages"]
    spawned = [b for m in messages if m["role"] == "assistant" for b in m["content"] if b["type"] == "tool_use"]
    done = {b["input"]["description"] for b in spawned}
    results = [b for m in messages if m["role"] == "user" and isinstance(m["content"], list) for b in m["content"]]
    pending = [t for t in RESEARCH_TASKS if t["description"] not in done]
    if pending:
        # A coordinator told to fan out emits every independent task in this one response.
        batch = pending if PARALLEL_SENTENCE in lab.system_text(params) else pending[:1]
        return lab.message(lab.text(f"Spawning {len(batch)} research subagent(s)."), *[lab.tool_use("Agent", t) for t in batch])
    if SYNTHESIS_LABEL not in done:
        # Synthesis depends on all research, so it waits; it gets the COMPLETE findings as JSON.
        findings = [f for r in results for f in json.loads(r["content"])]
        handoff = {"subagent_type": "synthesizer", "description": SYNTHESIS_LABEL, "prompt": structured_handoff(TOPIC, findings)}
        return lab.message(lab.tool_use("Agent", handoff))
    return lab.message(lab.text(results[-1]["content"]))


def scripted_world(params: dict[str, Any]) -> lab.Obj:
    system = lab.system_text(params)
    for name, spec in AGENT_SPECS.items():
        if system == spec["prompt"]:
            return scripted_subagent(name, params)
    return scripted_coordinator(params)


# ---------------------------------------------------------------------------
# Executors and the coordinator loop
# ---------------------------------------------------------------------------


async def run_subagent(client: Any, block: Any) -> dict[str, Any]:
    """One subagent = one call with its own system prompt and a fresh one-message context."""
    spec = AGENT_SPECS[block.input["subagent_type"]]
    response = await client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=spec["prompt"],
        messages=[{"role": "user", "content": block.input["prompt"]}],
    )
    return {"type": "tool_result", "tool_use_id": block.id, "content": lab.text_of(response)}


async def run_concurrently(client: Any, blocks: list[Any]) -> list[dict[str, Any]]:
    return list(await asyncio.gather(*(run_subagent(client, b) for b in blocks)))


async def run_one_by_one(client: Any, blocks: list[Any]) -> list[dict[str, Any]]:
    return [await run_subagent(client, b) for b in blocks]


Executor = Callable[[Any, list[Any]], Awaitable[list[dict[str, Any]]]]


async def run_coordinator(client: Any, system: str, executor: Executor) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": TOPIC}]
    calls_per_turn: list[int] = []
    start = time.perf_counter()
    for _ in range(SAFETY_MAX_TURNS):
        response = await client.messages.create(
            model=lab.MODEL, max_tokens=16000, system=system, tools=[AGENT_TOOL], messages=messages
        )
        messages.append({"role": "assistant", "content": response.content})
        spawns = [b for b in lab.tool_uses(response) if is_delegation(b.name)]
        calls_per_turn.append(len(spawns))
        if response.stop_reason != "tool_use":  # end_turn (D1.1 covers the other stop reasons)
            return {"answer": lab.text_of(response), "calls_per_turn": calls_per_turn,
                    "seconds": time.perf_counter() - start, "messages": messages}
        # Every result of this turn goes back in ONE user message, matched by tool_use_id.
        messages.append({"role": "user", "content": await executor(client, spawns)})
    raise RuntimeError(f"Coordinator did not finish in {SAFETY_MAX_TURNS} turns")


async def demo() -> None:
    scenarios = [
        ("A", "A - all Agent calls in one response, run concurrently", COORDINATOR_PROMPT, run_concurrently),
        ("B", "B - the same response, run one call at a time", COORDINATOR_PROMPT, run_one_by_one),
        ("C", "C - anti-pattern: one Agent call per coordinator turn", ONE_AT_A_TIME_PROMPT, run_concurrently),
    ]
    runs: dict[str, dict[str, Any]] = {}
    clients: dict[str, Any] = {}
    for key, title, system, executor in scenarios:
        lab.section(title)
        clients[key] = lab.get_async_client(scripted_world, latency_s=LATENCY_S)
        runs[key] = await run_coordinator(clients[key], system, executor)
        print(f"Agent calls per coordinator turn: {runs[key]['calls_per_turn']}")
        print(f"coordinator turns: {len(runs[key]['calls_per_turn'])}   wall-clock: {runs[key]['seconds']:.2f}s")

    lab.section("Result")
    print("  " + runs["A"]["answer"].replace("\n", "\n  "))
    a, b, c = (runs[k]["seconds"] for k in "ABC")
    print(f"wall-clock  A parallel {a:.2f}s | B same turn, sequential {b:.2f}s | C one per turn {c:.2f}s")

    first = runs["A"]["calls_per_turn"][0]
    if first:
        spawn_ids = {blk.id for blk in lab.tool_uses(lab.Obj(content=runs["A"]["messages"][1]["content"]))}
        answer_ids = {r["tool_use_id"] for r in runs["A"]["messages"][2]["content"]}
        lab.check(spawn_ids == answer_ids, f"the {first} results of the fan-out turn went back in ONE user message, matched by tool_use_id")
    if not lab.is_live():
        lab.check(runs["A"]["calls_per_turn"][0] == 4, "one coordinator response carried 4 Agent tool_use blocks")
        lab.check(max(runs["C"]["calls_per_turn"]) == 1 and len(runs["C"]["calls_per_turn"]) == 6,
                  "the anti-pattern needed 6 coordinator turns (one Agent call each) instead of 3")
        lab.check(a < b * 0.8, f"concurrent execution of that response beat sequential execution ({a:.2f}s vs {b:.2f}s)")
        lab.check(a < c * 0.6, f"parallel spawning beat one Agent call per turn ({a:.2f}s vs {c:.2f}s)")
        lab.check(runs["A"]["answer"] == runs["B"]["answer"] == runs["C"]["answer"], "same briefing every time: only latency changed")
        subagent_calls = [p for p in clients["A"].messages.calls if p["system"] != COORDINATOR_PROMPT]
        lab.check(all(len(p["messages"]) == 1 for p in subagent_calls), "every subagent started from a fresh one-message context")
        synth = next(p for p in subagent_calls if p["system"] == AGENT_SPECS["synthesizer"]["prompt"])
        lab.check(all(f["finding_id"] in synth["messages"][0]["content"] for f in FINDINGS),
                  "the synthesizer's prompt carried the complete findings from all four research subagents")


def main() -> None:
    lab.banner("D1.3  Parallel subagent spawning (multiple Agent calls in one response)")
    lab.run(demo())


if __name__ == "__main__":
    main()
