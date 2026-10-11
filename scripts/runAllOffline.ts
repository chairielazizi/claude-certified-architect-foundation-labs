/**
 * Run every TypeScript lab entry point offline and report PASS/FAIL.
 *
 * An entry point is any `D* /typescript/*.ts` file that calls `lab.banner(`. Files that
 * must not be auto-run (stdio MCP servers, live-only scripts) carry the marker
 * LAB_SKIP_AUTORUN in a comment.
 *
 * Usage:  npx tsx scripts/runAllOffline.ts [filter]      e.g.  npx tsx scripts/runAllOffline.ts D2.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 120_000;
const filter = process.argv[2] ?? "";

const entries: string[] = [];
for (const lab of readdirSync(ROOT).filter((d) => d.startsWith("D")).sort()) {
  const dir = path.join(ROOT, lab, "typescript");
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const full = path.join(dir, file);
    const rel = path.relative(ROOT, full);
    if (filter && !rel.includes(filter)) continue;
    const source = readFileSync(full, "utf-8");
    if (source.includes("lab.banner(") && !source.includes("LAB_SKIP_AUTORUN")) entries.push(full);
  }
}

const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const failures: string[] = [];
for (const full of entries) {
  const rel = path.relative(ROOT, full);
  const env = { ...process.env };
  delete env.LAB_LIVE;
  const start = Date.now();
  const proc = spawnSync(process.execPath, [tsxCli, full], {
    cwd: path.dirname(full),
    env,
    encoding: "utf-8",
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ok = proc.status === 0;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${rel}  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  if (!ok) {
    failures.push(rel);
    const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}${proc.error ? String(proc.error) : ""}`;
    console.log(output.trim().split("\n").slice(-25).map((l) => `    ${l}`).join("\n"));
  }
}
console.log(`\n${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
