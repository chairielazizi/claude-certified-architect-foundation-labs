"""D5.4 - Crash recovery from structured state exports and a coordinator manifest.

Four agents map the refund path. Each agent exports its state to a known location,
.lab-runtime/state/<agent>.json, and the coordinator keeps .lab-runtime/manifest.json
(agent, status, state_path) current after every transition.

The first run crashes in the middle of notification_flow. The resumed run starts from
nothing but the files on disk: it loads the manifest, skips completed agents, re-runs the
interrupted one, and injects the saved findings of completed agents into the prompts of
the agents that still have to run.

Run:  python crash_recovery.py          (offline)
      python crash_recovery.py --live   (real API; the crash is still simulated)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from explorer import EXPLORER_PROMPT, EXPLORER_TOOLS, LAB_DIR, REVIEWER_PROMPT, RUNTIME, reset_runtime, run_agent, scripted_model  # noqa: E402

MANIFEST = RUNTIME / "manifest.json"
AGENTS = [
    {"name": "test_inventory", "task": "Find all test files under tests/ and summarize what each one covers."},
    {"name": "refund_flow", "task": "Trace refund flow dependencies starting from the HTTP handler post_refund."},
    {"name": "notification_flow", "task": "Trace notification dependencies starting from class RefundNotifier."},
    {"name": "risk_review", "task": "Review the findings below for risky couplings in the refund path.", "reviewer": True},
]


class SimulatedCrash(Exception):
    pass


def state_path(name: str) -> str:
    return f".lab-runtime/state/{name}.json"  # relative to the lab folder: a KNOWN location


def write_json(rel_or_abs: Path, data: Any) -> None:
    rel_or_abs.parent.mkdir(parents=True, exist_ok=True)
    rel_or_abs.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


class Coordinator:
    """Holds no state of its own that matters: everything needed to resume is on disk."""

    def __init__(self, client: Any, starts: dict[str, int]) -> None:
        self.client = client
        self.starts = starts  # observed by the demo across both "processes"
        self.prompts: dict[str, str] = {}

    @staticmethod
    def new_manifest() -> dict[str, Any]:
        return {"run_id": "explore-001", "agents": [{"name": a["name"], "status": "pending", "state_path": state_path(a["name"])} for a in AGENTS]}

    @staticmethod
    def load_manifest() -> dict[str, Any]:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))

    def export_state(self, name: str, status: str, findings: str, examined: list[str]) -> None:
        write_json(LAB_DIR / state_path(name), {"agent": name, "status": status, "findings": findings, "examined": examined})

    def run(self, manifest: dict[str, Any], crash_in: str | None = None) -> None:
        write_json(MANIFEST, manifest)
        prior: dict[str, str] = {}
        for entry in manifest["agents"]:
            agent = next(a for a in AGENTS if a["name"] == entry["name"])
            path = LAB_DIR / entry["state_path"]
            if entry["status"] == "completed":
                prior[agent["name"]] = json.loads(path.read_text(encoding="utf-8"))["findings"]
                print(f"  skip  {agent['name']:18} completed; findings loaded from {entry['state_path']}")
                continue
            interrupted = entry["status"] == "running"
            entry["status"] = "running"
            write_json(MANIFEST, manifest)
            prompt = agent["task"]
            if prior:  # inject saved state from completed agents into this agent's prompt
                prompt += "\n\nFindings from completed agents (loaded from their state files):\n"
                prompt += "\n\n".join(f"### {name}\n{findings}" for name, findings in prior.items())
            if interrupted and path.exists():
                partial = json.loads(path.read_text(encoding="utf-8"))
                prompt += f"\n\nNote: a previous attempt was interrupted after examining {json.dumps(partial['examined'], separators=(',', ':'))}."
            self.prompts[agent["name"]] = prompt
            self.starts[agent["name"]] = self.starts.get(agent["name"], 0) + 1
            print(f"  {'rerun' if interrupted else 'run':5} {agent['name']:18} prompt {len(prompt):,} chars")

            examined: list[str] = []

            def on_tool_result(tool: str, args: dict[str, Any], name: str = agent["name"]) -> None:
                examined.append(f"{tool}:{args.get('path') or args.get('pattern')}")
                self.export_state(name, "in_progress", "", examined)  # progress is on disk before anything can fail
                if crash_in == name:
                    raise SimulatedCrash(f"process died while {name} was running")

            reviewer = bool(agent.get("reviewer"))
            result = run_agent(
                self.client,
                REVIEWER_PROMPT if reviewer else EXPLORER_PROMPT,
                prompt,
                [] if reviewer else EXPLORER_TOOLS,
                on_tool_result=on_tool_result,
            )
            self.export_state(agent["name"], "completed", result["answer"], examined)
            entry["status"] = "completed"
            write_json(MANIFEST, manifest)
            prior[agent["name"]] = result["answer"]


def statuses() -> list[str]:
    return [a["status"] for a in Coordinator.load_manifest()["agents"]]


def main() -> None:
    lab.banner("D5.4  Crash recovery with state exports and a manifest")
    reset_runtime()
    starts: dict[str, int] = {}

    lab.section("Run 1: crashes in the middle of notification_flow")
    try:
        Coordinator(lab.get_client(scripted_model), starts).run(Coordinator.new_manifest(), crash_in="notification_flow")
    except SimulatedCrash as exc:
        print(f"  CRASH: {exc}. All in-memory state is gone.")
    after_crash = statuses()
    print(f"  manifest on disk: {json.dumps(dict(zip([a['name'] for a in AGENTS], after_crash)), separators=(',', ':'))}")

    lab.section("Run 2: a NEW coordinator resumes from the manifest")
    resumed = Coordinator(lab.get_client(scripted_model), starts)
    resumed.run(Coordinator.load_manifest())
    review = json.loads((LAB_DIR / state_path("risk_review")).read_text(encoding="utf-8"))["findings"]
    print("risk_review findings:\n  " + review.replace("\n", "\n  "))

    lab.section("Contrast: the same review without injected state")
    blind = run_agent(lab.get_client(scripted_model), REVIEWER_PROMPT, AGENTS[3]["task"], [])
    print(f"  {blind['answer']}")

    lab.section("Checks")
    lab.check(after_crash == ["completed", "completed", "running", "pending"], "after the crash the manifest shows exactly where the run stopped")
    lab.check(
        starts == {"test_inventory": 1, "refund_flow": 1, "notification_flow": 2, "risk_review": 1},
        "resume skipped completed agents and re-ran only the interrupted one",
    )
    prompt = resumed.prompts["risk_review"]
    lab.check(
        "AcmePayClient.refund -> LedgerJournal.record" in prompt and "MAX_RETRIES = 0" in prompt,
        "risk_review's prompt carried findings loaded from the completed agents' state files",
    )
    lab.check(statuses() == ["completed"] * 4, "the final manifest shows every agent completed")
    files_ok = all(json.loads((LAB_DIR / state_path(a["name"])).read_text(encoding="utf-8"))["status"] == "completed" for a in AGENTS)
    lab.check(files_ok, "every agent exported its final state to its known location")
    if not lab.is_live():
        lab.check(review.count("\n- ") == 3 and "cannot assess" in blind["answer"], "with injected state the review found 3 risks; without it, none")


if __name__ == "__main__":
    main()
