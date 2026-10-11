/**
 * D5.6 - The synthesis report: explicit sections, provenance on every claim.
 *
 *   ## Well-established findings
 *       ### Financial data      -> markdown table (value, data period, sources)
 *       ### News                -> prose, citations inline
 *       ### Technical findings  -> bulleted list with methodology
 *   ## Contested findings       -> both values, both sources, the coordinator's decision
 *   ## Coverage gaps            -> requested subtopics no source covered
 *   ## Sources                  -> document, URL, publication date, data period, methodology
 *
 * Run:  npx tsx provenanceReport.ts          (offline)
 *       npx tsx provenanceReport.ts --live   (real model as coordinator)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import { allClaims, analyze, claimUnits, reconcile, renderReport, scriptedModel, section } from "./provenance.ts";

lab.banner("D5.6  Synthesis report with provenance and content-appropriate rendering");
const analysis = analyze(allClaims());
const decisions = await reconcile(lab.getClient(scriptedModel), analysis.conflicts);
const report = renderReport(analysis, decisions);
console.log(report);

lab.section("Checks");
const units = claimUnits(report);
const established = section(report, "Well-established findings");
const contested = section(report, "Contested findings");
const financial = section(established, "Financial data", "### ");
const news = section(established, "News", "### ");
const technical = section(established, "Technical findings", "### ");
// 3 table rows + 2 news sentences + 2 technical bullets + 1 contested bullet
lab.check(units.length === 8 && units.every((u) => u.includes("[S")), `all ${units.length} rendered claims carry at least one citation`);
lab.check(
  ["1.2 USD bn", "0.8 USD bn", "[S2]", "[S5]"].every((s) => contested.includes(s)),
  "the contested section keeps both values, each attributed to its source",
);
lab.check(
  !contested.includes("streaming") && established.includes("Temporal difference, not a contradiction"),
  "the 2024 vs 2026 streaming figures are presented as a trend, not as a contradiction",
);
lab.check(section(report, "Coverage gaps").includes("session musician employment"), "the uncovered subtopic is reported as a coverage gap");
lab.check(
  financial.includes("| Finding |") &&
    !news.includes("- ") &&
    !news.includes("|") &&
    technical
      .split("\n")
      .filter((line) => line.trim())
      .every((line) => line.startsWith("- ")),
  "financial data is a table, news is prose, technical findings are a bulleted list",
);
lab.check(financial.includes("[S1] [S4]"), "the market-size row cites both agreeing sources");
const sources = section(report, "Sources")
  .split("\n")
  .filter((line) => line.startsWith("- [S"));
lab.check(sources.length === 12 && sources.every((s) => s.includes("Published") && s.includes("data ")), "every source lists its publication date and data period");
