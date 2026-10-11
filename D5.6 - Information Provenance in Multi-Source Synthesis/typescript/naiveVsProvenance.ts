/**
 * D5.6 - Naive summarization loses attribution; merged claim-source mappings keep it.
 *
 * Three subagents return 12 structured claim-source mappings from 12 sources.
 *
 *   A  naive       "summarize these findings into one paragraph" -> fluent text, no sources,
 *                  one value picked where sources disagree, the newer figure dropped
 *   B  provenance  merge the mappings by claim and value: the same claim from two sources
 *                  becomes one finding with two citations, and nothing loses its source
 *
 * Run:  npx tsx naiveVsProvenance.ts          (offline)
 *       npx tsx naiveVsProvenance.ts --live   (real model writes the naive summary)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { FIXTURE, allClaims, analyze, cites, periods, scriptedModel, summarizeNaively } from "./provenance.ts";

lab.banner("D5.6  Naive summarization vs claim-source mappings");
const claims = allClaims();
console.log(`${claims.length} claim-source mappings from ${FIXTURE.subagents.length} subagents`);
const { agent: _agent, ...mapping } = claims[9];
lab.show("one mapping, as returned by the document_analysis subagent", mapping);

lab.section("A - naive: summarize the findings into one paragraph");
const summary = await summarizeNaively(lab.getClient(scriptedModel), claims);
console.log(summary);

lab.section("B - provenance-preserving merge (claim_key -> value -> citations)");
const analysis = analyze(claims);
for (const g of analysis.groups) {
  for (const v of g.variants) {
    const value = v.value ? `${v.value} ${v.unit}` : "-";
    console.log(`  ${g.claim_key.padEnd(26)} ${value.padEnd(28)} ${cites(v, analysis.index).padEnd(10)} period ${periods(v).join(", ") || "n/a"}`);
  }
}

lab.section("Checks");
const merged = new Map(analysis.groups.map((g) => [g.claim_key, g]));
const totalCitations = analysis.groups.reduce((sum, g) => sum + g.variants.reduce((s, v) => s + v.citations.length, 0), 0);
lab.check(totalCitations === claims.length, "every input mapping survived synthesis as a citation");
lab.check(analysis.index.size === 12, "all 12 distinct sources are still referenced");
const market = merged.get("market_size_2025")?.variants ?? [];
lab.check(
  market.length === 1 && new Set(market[0].citations.map((c) => c.source_url)).size === 2,
  "the same claim from two sources became ONE finding with TWO citations",
);
const fields = ["evidence_excerpt", "publication_date", "data_collection_period", "methodology"];
lab.check(claims.every((c) => fields.every((f) => f in c)), "each citation keeps its excerpt, publication date, data period and methodology");
if (!lab.isLive()) {
  lab.check(!summary.includes("http") && !summary.includes("Report"), "A: the summary carries no URLs and no document names");
  lab.check(summary.includes("1.2") && !summary.includes("0.8"), "A: where two credible sources disagreed, the summary silently picked one");
  lab.check(
    summary.includes("4%") && !summary.includes("9%") && !summary.includes("2024"),
    "A: the newer streaming figure vanished, and the older one lost its period",
  );
}
