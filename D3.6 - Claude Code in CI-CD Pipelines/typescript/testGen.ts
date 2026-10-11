/**
 * D3.6 - Generate tests in CI without repeating the existing suite.
 *
 *   1. CLAUDE.md documents testing standards, what makes a test valuable, and the available fixtures
 *      (`claude -p` loads it automatically in CI; with the Messages API we pass it as the system prompt).
 *   2. The existing test files go into the prompt, so Claude doesn't propose covered scenarios.
 *   A deterministic dedupe against the existing tests then catches paraphrased repeats.
 *
 * Run:  npx tsx testGen.ts          (offline: scripted proposals)
 *       npx tsx testGen.ts --live   (real Claude, structured output against ci/test-scenarios.schema.json)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_REPO = path.join(LAB, "example-repo");
const readText = (...parts: string[]) => readFileSync(path.join(EXAMPLE_REPO, ...parts), "utf-8").replace(/\r\n/g, "\n");
const SCHEMA: unknown = JSON.parse(readText("ci", "test-scenarios.schema.json"));
const SOURCE = readText("src", "payments", "refunds.py");
const EXISTING_TESTS = readText("tests", "test_refunds.py");
const CLAUDE_MD = readText("CLAUDE.md");
const DOCUMENTED_FIXTURES = new Set(["db", "charge_factory", "fake_gateway", "caplog", "monkeypatch"]);
const STOPWORDS = new Set(["test", "a", "an", "the", "that", "has", "not", "is", "of", "on", "with", "for", "to", "and", "be", "it", "at"]);
const SIMILARITY = 0.5;

interface Scenario {
  name: string;
  behavior: string;
  fixtures: string[];
  catches: string;
}

const generationPrompt = (includeExisting: boolean) =>
  `Propose pytest scenarios for refund_charge.\n\nsrc/payments/refunds.py:\n\`\`\`python\n${SOURCE}\`\`\`` +
  (includeExisting ? `\n\nExisting tests (already covered - do not propose these scenarios again):\n\`\`\`python\n${EXISTING_TESTS}\`\`\`` : "");

const systemPrompt = (includeClaudeMd: boolean) =>
  "You write pytest tests. Return scenarios only; one behavior per scenario." + (includeClaudeMd ? `\n\nProject context (CLAUDE.md):\n${CLAUDE_MD}` : "");

async function propose(client: lab.MessagesClient, system: string, prompt: string): Promise<Scenario[]> {
  // Cast because output_config is newer than some SDK type definitions.
  const params = {
    model: lab.MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  } as unknown as lab.CreateParams;
  const response = await client.messages.create(params);
  return (JSON.parse(lab.textOf(response)) as { scenarios: Scenario[] }).scenarios;
}

/** Test names and docstrings already in the suite. */
function existingScenarios(source: string): Array<{ name: string; behavior: string }> {
  return [...source.matchAll(/def (test_\w+)\(.*?\):\n\s+"""([\s\S]*?)"""/g)].map((m) => ({ name: m[1], behavior: m[2] }));
}

const tokens = (s: { name: string; behavior: string }) =>
  new Set((`${s.name} ${s.behavior}`.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w)));

/** Drop proposals whose name+behavior overlap an existing test by Jaccard >= SIMILARITY. */
function dedupe(proposed: Scenario[], existing: Array<{ name: string; behavior: string }>): [Scenario[], Array<[string, string, number]>] {
  const kept: Scenario[] = [];
  const dropped: Array<[string, string, number]> = [];
  for (const scenario of proposed) {
    let best = 0;
    let bestName = "";
    for (const e of existing) {
      const a = tokens(scenario);
      const b = tokens(e);
      const score = [...a].filter((w) => b.has(w)).length / new Set([...a, ...b]).size;
      if (score > best) [best, bestName] = [score, e.name];
    }
    if (best >= SIMILARITY) dropped.push([scenario.name, bestName, Math.round(best * 100) / 100]);
    else kept.push(scenario);
  }
  return [kept, dropped];
}

// ---------------------------------------------------------------------------
// Offline stand-in for Claude: what it proposes depends on what is in its context
// ---------------------------------------------------------------------------

const STD = ["db", "charge_factory", "fake_gateway"];
const PROPOSALS: Array<Scenario & { verbatimDuplicate?: boolean }> = [
  // obvious duplicates of existing tests (Claude drops these once it can see the test file)
  { name: "test_full_refund_of_settled_charge", behavior: "A full refund of a settled charge succeeds and records the refund.", fixtures: STD, catches: "refunds not recorded", verbatimDuplicate: true },
  { name: "test_refund_exceeding_charge_rejected", behavior: "A refund larger than the original charge raises REFUND_EXCEEDS_CHARGE.", fixtures: STD, catches: "missing limit check", verbatimDuplicate: true },
  // a paraphrased duplicate that survives the context and is caught by dedupe()
  { name: "test_unsettled_charge_refund_rejected", behavior: "Refunding a charge that has not settled raises CHARGE_NOT_SETTLED.", fixtures: STD, catches: "refunding pending charges" },
  // genuinely new, valuable scenarios
  { name: "test_second_partial_refund_cannot_exceed_charge", behavior: "Two partial refunds whose total exceeds the charge: the second raises REFUND_EXCEEDS_CHARGE.", fixtures: STD, catches: "the limit ignores earlier refunds" },
  { name: "test_refund_amount_parsed_exactly", behavior: 'Refunding "1204.35" records exactly 120435 cents.', fixtures: STD, catches: "float money conversion" },
  { name: "test_replayed_idempotency_key_refunds_once", behavior: "Retrying with the same idempotency key calls the gateway once and returns the original refund.", fixtures: STD, catches: "idempotency key not forwarded" },
  { name: "test_card_number_never_logged", behavior: "Refund logs contain at most the last four card digits.", fixtures: [...STD, "caplog"], catches: "full card number in logs" },
];
const LOW_VALUE: Scenario = { name: "test_refund_dataclass_fields", behavior: "Refund has refund_id, charge_id, amount_cents and status fields.", fixtures: [], catches: "nothing plausible" };

function scriptedTestWriter(params: lab.CreateParams): Anthropic.Message {
  const knowsStandards = lab.systemText(params).includes("Available fixtures");
  const seesTests = lab.lastUserText(params).includes("Existing tests");
  const scenarios: Scenario[] = [];
  for (const p of PROPOSALS) {
    if (seesTests && p.verbatimDuplicate) continue;
    // no fixture docs -> invented mocks
    scenarios.push({ name: p.name, behavior: p.behavior, fixtures: knowsStandards ? p.fixtures : ["mock_db", "mock_gateway"], catches: p.catches });
  }
  if (!knowsStandards) scenarios.push(LOW_VALUE); // no "valuable test" criteria -> filler tests appear
  return lab.message([lab.text(JSON.stringify({ scenarios }))]);
}

function show(title: string, scenarios: Scenario[]): void {
  console.log(`  ${title}: ${scenarios.length} proposed`);
  for (const s of scenarios) console.log(`    - ${s.name.padEnd(50)} fixtures=${JSON.stringify(s.fixtures)}`);
}

lab.banner("D3.6  CI test generation: CLAUDE.md standards + existing tests in context");
const client = lab.getClient(scriptedTestWriter);
const existing = existingScenarios(EXISTING_TESTS);
console.log(`  existing tests: ${JSON.stringify(existing.map((e) => e.name))}`);

lab.section("A. No CLAUDE.md, no existing tests in context");
const bare = await propose(client, systemPrompt(false), generationPrompt(false));
show("A", bare);
const [, bareDupes] = dedupe(bare, existing);
console.log(`  duplicates of existing tests: ${JSON.stringify(bareDupes)}`);

lab.section("B. CLAUDE.md as system context + existing tests in the prompt");
const informed = await propose(client, systemPrompt(true), generationPrompt(true));
show("B", informed);
const [final, dupes] = dedupe(informed, existing);
console.log(`  dedupe dropped: ${JSON.stringify(dupes)}`);
console.log(`  final scenarios to generate: ${JSON.stringify(final.map((s) => s.name))}`);

lab.section("Checks");
lab.check([...DOCUMENTED_FIXTURES].every((f) => CLAUDE_MD.includes(`\`${f}`)), "the fixtures used for checking are the ones CLAUDE.md documents");
lab.check(generationPrompt(true).includes(EXISTING_TESTS), "B's prompt includes the existing test file verbatim");
lab.check(dedupe(final, existing)[1].length === 0, "no final scenario duplicates an existing test");
lab.check(final.every((s) => s.fixtures.every((f) => DOCUMENTED_FIXTURES.has(f))), "B only uses fixtures documented in CLAUDE.md");
if (!lab.isLive()) {
  lab.check(bareDupes.length === 3 && dupes.length === 1, "existing tests in context cut duplicates from 3 to 1; dedupe removes the last paraphrase");
  lab.check(
    bare.some((s) => s.fixtures.some((f) => !DOCUMENTED_FIXTURES.has(f))) && bare.some((s) => s.name === LOW_VALUE.name),
    "without CLAUDE.md: invented mocks and a low-value filler test",
  );
  lab.check(final.length === 4, "4 new, valuable scenarios remain (cumulative limit, exact cents, idempotency, card logging)");
}
