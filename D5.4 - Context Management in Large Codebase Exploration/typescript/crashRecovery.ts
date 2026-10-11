/**
 * D5.4 - Crash recovery from structured state exports and a coordinator manifest.
 *
 * Four agents map the refund path. Each agent exports its state to a known location,
 * .lab-runtime/state/<agent>.json, and the coordinator keeps .lab-runtime/manifest.json
 * (agent, status, state_path) current after every transition.
 *
 * The first run crashes in the middle of notification_flow. The resumed run starts from
 * nothing but the files on disk: it loads the manifest, skips completed agents, re-runs the
 * interrupted one, and injects the saved findings of completed agents into the prompts of
 * the agents that still have to run.
 *
 * Run:  npx tsx crashRecovery.ts          (offline)
 *       npx tsx crashRecovery.ts --live   (real API; the crash is still simulated)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { EXPLORER_PROMPT, EXPLORER_TOOLS, LAB_DIR, REVIEWER_PROMPT, RUNTIME, resetRuntime, runAgent, scriptedModel, type ToolArgs } from "./explorer.ts";

const MANIFEST = path.join(RUNTIME, "manifest.json");
const AGENTS: { name: string; task: string; reviewer?: boolean }[] = [
  { name: "test_inventory", task: "Find all test files under tests/ and summarize what each one covers." },
  { name: "refund_flow", task: "Trace refund flow dependencies starting from the HTTP handler post_refund." },
  { name: "notification_flow", task: "Trace notification dependencies starting from class RefundNotifier." },
  { name: "risk_review", task: "Review the findings below for risky couplings in the refund path.", reviewer: true },
];

class SimulatedCrash extends Error {}

interface ManifestEntry {
  name: string;
  status: string;
  state_path: string;
}
interface Manifest {
  run_id: string;
  agents: ManifestEntry[];
}
interface AgentState {
  agent: string;
  status: string;
  findings: string;
  examined: string[];
}

const statePath = (name: string) => `.lab-runtime/state/${name}.json`; // relative to the lab folder: a KNOWN location

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
const readState = (rel: string) => JSON.parse(readFileSync(path.join(LAB_DIR, rel), "utf-8")) as AgentState;

/** Holds no state of its own that matters: everything needed to resume is on disk. */
class Coordinator {
  readonly prompts: Record<string, string> = {};

  constructor(
    private readonly client: lab.MessagesClient,
    private readonly starts: Record<string, number>, // observed by the demo across both "processes"
  ) {}

  static newManifest(): Manifest {
    return { run_id: "explore-001", agents: AGENTS.map((a) => ({ name: a.name, status: "pending", state_path: statePath(a.name) })) };
  }

  static loadManifest(): Manifest {
    return JSON.parse(readFileSync(MANIFEST, "utf-8")) as Manifest;
  }

  exportState(name: string, status: string, findings: string, examined: string[]): void {
    writeJson(path.join(LAB_DIR, statePath(name)), { agent: name, status, findings, examined });
  }

  async run(manifest: Manifest, crashIn: string | null = null): Promise<void> {
    writeJson(MANIFEST, manifest);
    const prior = new Map<string, string>();
    for (const entry of manifest.agents) {
      const agent = AGENTS.find((a) => a.name === entry.name);
      if (!agent) throw new Error(`unknown agent ${entry.name}`);
      if (entry.status === "completed") {
        prior.set(agent.name, readState(entry.state_path).findings);
        console.log(`  skip  ${agent.name.padEnd(18)} completed; findings loaded from ${entry.state_path}`);
        continue;
      }
      const interrupted = entry.status === "running";
      entry.status = "running";
      writeJson(MANIFEST, manifest);
      let prompt = agent.task;
      if (prior.size) {
        // inject saved state from completed agents into this agent's prompt
        prompt += "\n\nFindings from completed agents (loaded from their state files):\n";
        prompt += [...prior.entries()].map(([name, findings]) => `### ${name}\n${findings}`).join("\n\n");
      }
      if (interrupted && existsSync(path.join(LAB_DIR, entry.state_path))) {
        prompt += `\n\nNote: a previous attempt was interrupted after examining ${JSON.stringify(readState(entry.state_path).examined)}.`;
      }
      this.prompts[agent.name] = prompt;
      this.starts[agent.name] = (this.starts[agent.name] ?? 0) + 1;
      console.log(`  ${(interrupted ? "rerun" : "run").padEnd(5)} ${agent.name.padEnd(18)} prompt ${prompt.length.toLocaleString("en-US")} chars`);

      const examined: string[] = [];
      const name = agent.name;
      const onToolResult = (tool: string, args: ToolArgs) => {
        examined.push(`${tool}:${args.path || args.pattern}`);
        this.exportState(name, "in_progress", "", examined); // progress is on disk before anything can fail
        if (crashIn === name) throw new SimulatedCrash(`process died while ${name} was running`);
      };
      const result = await runAgent(
        this.client,
        agent.reviewer ? REVIEWER_PROMPT : EXPLORER_PROMPT,
        prompt,
        agent.reviewer ? [] : EXPLORER_TOOLS,
        undefined,
        onToolResult,
      );
      this.exportState(name, "completed", result.answer, examined);
      entry.status = "completed";
      writeJson(MANIFEST, manifest);
      prior.set(name, result.answer);
    }
  }
}

const statuses = () => Coordinator.loadManifest().agents.map((a) => a.status);

lab.banner("D5.4  Crash recovery with state exports and a manifest");
resetRuntime();
const starts: Record<string, number> = {};

lab.section("Run 1: crashes in the middle of notification_flow");
try {
  await new Coordinator(lab.getClient(scriptedModel), starts).run(Coordinator.newManifest(), "notification_flow");
} catch (exc) {
  if (!(exc instanceof SimulatedCrash)) throw exc;
  console.log(`  CRASH: ${exc.message}. All in-memory state is gone.`);
}
const afterCrash = statuses();
const byName: Record<string, string> = {};
AGENTS.forEach((a, i) => (byName[a.name] = afterCrash[i]));
console.log(`  manifest on disk: ${JSON.stringify(byName)}`);

lab.section("Run 2: a NEW coordinator resumes from the manifest");
const resumed = new Coordinator(lab.getClient(scriptedModel), starts);
await resumed.run(Coordinator.loadManifest());
const review = readState(statePath("risk_review")).findings;
console.log("risk_review findings:\n  " + review.replaceAll("\n", "\n  "));

lab.section("Contrast: the same review without injected state");
const blind = await runAgent(lab.getClient(scriptedModel), REVIEWER_PROMPT, AGENTS[3].task, []);
console.log(`  ${blind.answer}`);

lab.section("Checks");
lab.check(JSON.stringify(afterCrash) === JSON.stringify(["completed", "completed", "running", "pending"]), "after the crash the manifest shows exactly where the run stopped");
lab.check(
  JSON.stringify(starts) === JSON.stringify({ test_inventory: 1, refund_flow: 1, notification_flow: 2, risk_review: 1 }),
  "resume skipped completed agents and re-ran only the interrupted one",
);
const reviewPrompt = resumed.prompts.risk_review ?? "";
lab.check(
  reviewPrompt.includes("AcmePayClient.refund -> LedgerJournal.record") && reviewPrompt.includes("MAX_RETRIES = 0"),
  "risk_review's prompt carried findings loaded from the completed agents' state files",
);
lab.check(statuses().every((s) => s === "completed"), "the final manifest shows every agent completed");
lab.check(AGENTS.every((a) => readState(statePath(a.name)).status === "completed"), "every agent exported its final state to its known location");
if (!lab.isLive()) {
  lab.check(review.split("\n- ").length - 1 === 3 && blind.answer.includes("cannot assess"), "with injected state the review found 3 risks; without it, none");
}
