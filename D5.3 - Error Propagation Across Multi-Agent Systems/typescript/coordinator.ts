/**
 * D5.3 - Structured error propagation lets the coordinator recover intelligently.
 *
 * The coordinator (a Claude agent with delegate_search / submit_coverage tools) fans out six
 * research subtopics in one turn. Each search subagent recovers locally from transient
 * failures and returns a structured envelope for anything it cannot resolve. The coordinator
 * reads the envelopes and picks a recovery per failure:
 *
 *   film      timeout on a broad query, 3 local attempts, 1 partial result -> retry with a NARROWER query
 *   writing   access_denied (not retried locally)                          -> try the ALTERNATIVE source
 *   games     rate_limited, source says "retry in 900 s" (> 300 s budget)  -> PROCEED with partial, annotate
 *   music     one timeout, recovered inside the subagent                   -> coordinator just sees success
 *   architecture  search worked, zero matches                              -> valid empty result, no retry
 *
 * Synthesis then reports findings with coverage annotations.
 *
 * Run:  npx tsx coordinator.ts          (offline, scripted coordinator)
 *       npx tsx coordinator.ts --live   (real model as coordinator; sources stay simulated)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";
import {
  COORDINATOR_PROMPT,
  COORDINATOR_TOOLS,
  PLAN,
  TOPIC,
  scriptedCoordinator,
  structuredSubagent,
  synthesize,
  type Envelope,
  type SearchRequest,
} from "./researchSystem.ts";

const SAFETY_MAX_ITERATIONS = 10;

interface CoverageDecision {
  subtopic: string;
  decision: string;
  note: string;
}

async function runCoordinator(client: lab.MessagesClient) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Research topic: ${TOPIC}\nSubtopics and starting sources:\n${JSON.stringify(PLAN, null, 2)}` },
  ];
  const history = new Map<string, Envelope[]>();
  const turns: Envelope[][] = [];
  let decisions: CoverageDecision[] = [];
  for (let i = 0; i < SAFETY_MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: lab.MODEL,
      max_tokens: 16000,
      system: COORDINATOR_PROMPT,
      tools: COORDINATOR_TOOLS,
      messages: [...messages],
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return { history, turns, decisions, final: lab.textOf(response) };
    const results: Anthropic.ToolResultBlockParam[] = [];
    const batch: Envelope[] = [];
    for (const block of lab.toolUses(response)) {
      if (block.name === "delegate_search") {
        const args = block.input as SearchRequest;
        const env = structuredSubagent(args.subtopic, args.source, args.query);
        const envs = history.get(env.subtopic) ?? [];
        envs.push(env);
        history.set(env.subtopic, envs);
        batch.push(env);
        // is_error when nothing usable came back; the envelope still explains why
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(env), ...(env.status === "failed" ? { is_error: true } : {}) });
      } else {
        // submit_coverage
        decisions = (block.input as { decisions: CoverageDecision[] }).decisions;
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ recorded: decisions.length }) });
      }
    }
    if (batch.length) turns.push(batch);
    messages.push({ role: "user", content: results }); // all results for the turn in ONE message
  }
  throw new Error("coordinator did not finish");
}

lab.banner("D5.3  Structured error context drives coordinator recovery");
const run = await runCoordinator(lab.getClient(scriptedCoordinator));

run.turns.forEach((batch, i) => {
  lab.section(`Coordinator turn ${i + 1}: ${batch.length} delegation(s)`);
  for (const env of batch) {
    const outcomes = (env.attempts ?? []).map((a) => a.outcome + (a.backoff_ms ? `(+${a.backoff_ms}ms)` : ""));
    console.log(
      `  ${env.subtopic.padEnd(12)} ${(env.source ?? "").padEnd(16)} ${env.status.padEnd(8)} ${(env.failure_type ?? "-").padEnd(13)} attempts: ${outcomes.join(" ")}`,
    );
    if (env.status !== "success") {
      console.log(`      attempted_query='${env.attempted_query}' partial=${(env.partial_results ?? []).length}`);
      console.log(`      alternatives=${JSON.stringify(env.alternatives)}`);
    }
  }
});

lab.section("Coverage decisions submitted by the coordinator");
for (const d of run.decisions) console.log(`  ${d.subtopic.padEnd(12)} ${d.decision.padEnd(21)} ${d.note}`);

lab.section("Synthesis with coverage annotations");
const { report, rows } = synthesize(run.history);
console.log(report);

lab.section("Checks");
// Subagent behaviour is deterministic (simulated sources), so these hold in live mode too.
const plan = new Map(PLAN.map((p) => [p.subtopic, p]));
const call = (s: string) => {
  const p = plan.get(s);
  if (!p) throw new Error(`no plan for ${s}`);
  return structuredSubagent(p.subtopic, p.source, p.query);
};
const music = call("music");
const writing = call("writing");
const film = call("film");
const architecture = call("architecture");
lab.check(
  music.status === "success" && JSON.stringify((music.attempts ?? []).map((a) => a.outcome)) === '["timeout","ok"]',
  "music: the transient timeout was retried inside the subagent; the coordinator only sees a success",
);
lab.check(
  writing.failure_type === "access_denied" && (writing.attempts ?? []).length === 1 && (writing.alternatives ?? []).length > 0,
  "writing: access_denied propagated at once (retrying cannot fix permissions), with alternatives",
);
lab.check(
  film.status === "partial" && JSON.stringify((film.attempts ?? []).map((a) => a.backoff_ms)) === "[200,400,0]" && (film.partial_results ?? []).length > 0,
  "film: unresolved timeout propagated with the attempted query, 3 backoff attempts and partial results",
);
lab.check(
  architecture.status === "success" && architecture.match_count === 0 && architecture.failure_type === null,
  "architecture: zero matches is a SUCCESS (valid empty result), not an access failure",
);
if (!lab.isLive()) {
  const recovery = run.turns[1].map((e) => [e.subtopic, e.source, e.attempted_query].join("|")).sort();
  const writingQuery = plan.get("writing")?.query ?? "";
  lab.check(
    JSON.stringify(recovery) === JSON.stringify(["film|web_search|AI visual effects film production", `writing|industry_reports|${writingQuery}`]),
    "coordinator: narrowed the film query and switched the writing source, both from envelope alternatives",
  );
  lab.check(run.history.get("architecture")?.length === 1, "coordinator: did not retry the valid empty result");
  const status = new Map(rows.map((r) => [r.subtopic, r.status]));
  lab.check(
    status.get("games") === "gap: partial results" && status.get("architecture") === "no published data" && rows.length === PLAN.length,
    "synthesis: every subtopic has a coverage row; the gap and the genuine 'no data' are labelled differently",
  );
  lab.check(
    ["visual_arts", "music", "writing", "film"].every((s) => status.get(s) === "well-supported"),
    "synthesis: recovered subtopics are well-supported; only games is a gap",
  );
}
