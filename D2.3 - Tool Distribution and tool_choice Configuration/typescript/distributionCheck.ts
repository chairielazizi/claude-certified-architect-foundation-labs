/**
 * D2.3 - Review how tools are distributed across subagents, and route verification (Q9).
 *
 *   1. scoped config:              every agent has only its role's tools (+ verify_fact, justified)
 *   2. "give everyone everything": 18 tools per agent -> warnings for count and specialization
 *   3. sample Q9 option C:         synthesis agent given the web search tools -> flagged
 *   4. verification routing:       simple facts via the scoped verify_fact, complex claims back
 *                                  through the coordinator; round trips before vs after
 *
 * Always offline (no model involved). Run:  npx tsx distributionCheck.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { EVERYTHING_CONFIG, SCOPED_CONFIG, checkDistribution, count, toolDefinition, type Finding } from "./toolRegistry.ts";

// Fictional claims a synthesis agent meets while combining findings (85% simple / 15% complex).
const CLAIMS = [
  "Studio Aurora released 'Glass Harbor' on 14 March 2025.",
  "The Northwind Music Report puts 2025 streaming revenue at $31.2B.",
  "Lumen Labs was founded in 2019.",
  "Painter Ada Brandt won the 2024 Halden Prize.",
  "The Halden Prize is awarded in Oslo.",
  "Vireo Pictures employs 1,200 people.",
  "The SoundSmith plugin reached version 2.0 in 2024.",
  "Novella Press published 340 titles in 2025.",
  "Composer Rui Tanaka scored 'Low Tide'.",
  "The Creative AI Survey had 4,800 respondents.",
  "Pixelforge v6 shipped on 2 December 2025.",
  "The Brightline Festival takes place in Lisbon.",
  "Mara Quinn is the CEO of Lumen Labs.",
  "'Low Tide' runs 118 minutes.",
  "The guild agreement was signed on 9 October 2025.",
  "Northwind counted 61% of labels using AI mastering.",
  "Echo Records is headquartered in Manchester.",
  "AI tools caused the drop in stock-illustration prices since 2023.",
  "Compared with 2022, AI-assisted films earn more at the box office.",
  "There is a consensus among session musicians that AI will reduce their work.",
];

// verify_fact's description draws the boundary the synthesis agent applies: one atomic,
// checkable fact -> verify_fact; causal / comparative / consensus claims -> coordinator.
const COMPLEX_MARKERS = /\b(caus\w*|led to|due to|because|compared|more than|consensus|trend|impact)\b/i;
const ROUND_TRIPS_VIA_COORDINATOR = 2; // synthesis -> coordinator -> web search agent -> coordinator -> synthesis

const routeClaim = (claim: string) => (COMPLEX_MARKERS.test(claim) ? "coordinator" : "verify_fact");

function printReport(report: Record<string, Finding[]>): void {
  for (const [role, findings] of Object.entries(report)) {
    console.log(`  ${role}: ${findings.length === 0 ? "ok" : ""}`);
    for (const [level, message] of findings) console.log(`      [${level}] ${message}`);
  }
}

lab.banner("D2.3  Scoped tool distribution across subagents");

lab.section("1. Scoped config (role tools only)");
console.log(`  ${JSON.stringify(SCOPED_CONFIG)}`);
const scoped = checkDistribution(SCOPED_CONFIG);
printReport(scoped);

lab.section("2. 'Give everyone everything' (18 tools per agent)");
const everything = checkDistribution(EVERYTHING_CONFIG);
printReport(everything);
const payload = (tools: string[]) => tools.reduce((n, t) => n + JSON.stringify(toolDefinition(t)).length, 0);
console.log(
  `  tool-definition payload per request: ${JSON.stringify({
    "scoped synthesis_agent": payload(SCOPED_CONFIG.synthesis_agent),
    "everything synthesis_agent": payload(EVERYTHING_CONFIG.synthesis_agent),
  })} (chars; every turn, every agent)`,
);

lab.section("3. Sample Q9 option C: give synthesis the web search tools");
const optionC = { ...SCOPED_CONFIG, synthesis_agent: ["verify_fact", "web_search", "load_document"] };
const optionCReport = checkDistribution(optionC);
printReport({ synthesis_agent: optionCReport.synthesis_agent });

lab.section("4. Verification routing with the scoped verify_fact (sample Q9 option A)");
const routes = CLAIMS.map((c) => [c, routeClaim(c)] as const);
for (const [claim, route] of routes) if (route === "coordinator") console.log(`  -> coordinator (deep check): ${claim}`);
const simple = routes.filter(([, r]) => r === "verify_fact").length;
const before = CLAIMS.length * ROUND_TRIPS_VIA_COORDINATOR;
const after = (CLAIMS.length - simple) * ROUND_TRIPS_VIA_COORDINATOR;
console.log(`  ${simple}/${CLAIMS.length} claims (${Math.round((simple / CLAIMS.length) * 100)}%) handled in-agent by verify_fact`);
console.log(`  coordinator round trips for verification: before ${before}, after ${after}`);

lab.section("Checks");
lab.check(count(scoped, "warn") === 0 && count(scoped, "error") === 0, "scoped config passes: no agent over the limit or outside its role");
lab.check(count(scoped, "info") === 1, "the one cross-role tool (verify_fact on synthesis) is explicit and justified");
lab.check(
  Object.values(everything).every((f) => f.some(([, m]) => m.includes("18 tools"))),
  "every agent in the 18-tool config is flagged for tool count",
);
lab.check(
  everything.synthesis_agent.some(([, m]) => m.includes("web_search")),
  "synthesis agent holding web_search is flagged as outside its specialization",
);
lab.check(optionCReport.synthesis_agent.some(([lvl]) => lvl === "warn"), "Q9 option C (all web tools on synthesis) is flagged as over-provisioned");
lab.check(simple === 17 && after < before, `85% of checks stay local; coordinator round trips ${before} -> ${after}`);
lab.check(CLAIMS.slice(-3).every((c) => routeClaim(c) === "coordinator"), "complex claims still go through the coordinator (not handled by verify_fact)");
