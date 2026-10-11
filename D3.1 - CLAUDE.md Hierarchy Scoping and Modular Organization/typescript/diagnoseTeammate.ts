/**
 * D3.1 - Diagnose a configuration-hierarchy bug: "Claude keeps running npm for the new hire".
 *
 * The lead wrote "Use pnpm, never npm" in THEIR ~/.claude/CLAUDE.md. It works for the lead, so nobody
 * notices it is not in version control. Resolve both developers' memory (what /memory shows each of
 * them), find which file provides the instruction, look at its scope, then move it to the project
 * CLAUDE.md, which git shares.
 *
 * Run:  npx tsx diagnoseTeammate.ts
 */
import { copyFileSync, cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as lab from "../../shared/typescript/labkit.ts";
import { EXAMPLE_REPO, LEAD_HOME, RUNTIME, TEAMMATE_HOME, readText, resolveMemory, type Resolution } from "./memoryResolver.ts";

const NEEDLE = "Use pnpm, never npm";
const PROJECT_LINE =
  "- Use pnpm, never npm or yarn (the version is pinned by `packageManager` in `package.json`). " +
  "npm and yarn write a second lockfile and bypass the workspace.";
const SHARED_SCOPES = new Set(["project", "rule", "subdir"]); // committed to git -> every clone gets them

interface Person {
  home: string;
  repo: string;
}

/** Two developers, each with their own home directory and their own checkout of the same commit. */
function setupWorkspace(): Record<string, Person> {
  const base = path.join(RUNTIME, "diagnose-ts");
  rmSync(base, { recursive: true, force: true });
  const people: Record<string, Person> = {
    lead: { home: path.join(base, "lead", "home"), repo: path.join(base, "lead", "acme-shop") },
    teammate: { home: path.join(base, "teammate", "home"), repo: path.join(base, "teammate", "acme-shop") },
  };
  cpSync(LEAD_HOME, people.lead.home, { recursive: true });
  cpSync(TEAMMATE_HOME, people.teammate.home, { recursive: true });
  for (const person of Object.values(people)) cpSync(EXAMPLE_REPO, person.repo, { recursive: true });
  // The lead also keeps a CLAUDE.local.md (gitignored): another file the teammate never receives.
  copyFileSync(path.join(people.lead.repo, "CLAUDE.local.md.example"), path.join(people.lead.repo, "CLAUDE.local.md"));
  return people;
}

function sessions(people: Record<string, Person>): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const [name, p] of Object.entries(people)) out[name] = resolveMemory(p.home, p.repo);
  return out;
}

/** Where an instruction comes from in one developer's session, as "scope:path". */
function sources(res: Resolution, needle: string): string[] {
  return res.find(needle).map((f) => `${f.scope}:${res.display(f.path)}`);
}

/** Bullet-point instructions in a session, mapped to the scope:path that provides them. */
function instructionLines(res: Resolution): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of res.files) {
    for (const line of f.text.split("\n")) {
      if (line.trimStart().startsWith("- ") && !found.has(line.trim())) found.set(line.trim(), `${f.scope}:${res.display(f.path)}`);
    }
  }
  return found;
}

/** The fix: delete the line from the lead's user memory and commit it to the project CLAUDE.md. */
function moveToProject(people: Record<string, Person>): void {
  const userMd = path.join(people.lead.home, ".claude", "CLAUDE.md");
  const kept = readText(userMd).split("\n").filter((line) => !line.includes(NEEDLE));
  writeFileSync(userMd, kept.join("\n").replace(/\n*$/, "\n"), "utf-8");
  for (const person of Object.values(people)) {
    // commit + `git pull`: every checkout gets the same project file
    const projectMd = path.join(person.repo, "CLAUDE.md");
    writeFileSync(projectMd, readText(projectMd).replace("## Tooling\n\n", `## Tooling\n\n${PROJECT_LINE}\n`), "utf-8");
  }
}

lab.banner("D3.1  Diagnose: the new teammate never got 'use pnpm, never npm'");
const people = setupWorkspace();

lab.section("Symptom: same repo, same commit, different behavior");
const before = sessions(people);
for (const [name, res] of Object.entries(before)) console.log(`\n/memory for ${name}:\n${res.listing()}`);

lab.section("Diagnosis: where does each session get the instruction?");
for (const [name, res] of Object.entries(before)) {
  const src = sources(res, NEEDLE);
  console.log(`  ${name.padEnd(9)} ${JSON.stringify(NEEDLE).padEnd(24)} -> ${src.length ? JSON.stringify(src) : "MISSING"}`);
}
const leadLines = instructionLines(before.lead);
const mateLines = instructionLines(before.teammate);
const leadOnly = [...leadLines].filter(([line]) => !mateLines.has(line));
console.log("\n  Instructions only the lead's sessions receive (and why):");
for (const [line, src] of leadOnly) console.log(`    [${src.split(":")[0]}] ${line.slice(0, 88)}`);
const leaked = leadOnly.filter(([line]) => line.includes(NEEDLE)).map(([, src]) => src);
console.log(`\n  -> "${NEEDLE}" is a TEAM convention stored in ${leaked[0]}, which is not in version control.`);
lab.check(sources(before.lead, NEEDLE).length > 0, "the lead's session has the instruction");
lab.check(sources(before.teammate, NEEDLE).length === 0, "the teammate's session does not (this is the bug)");
lab.check(JSON.stringify(leaked) === '["user:~/.claude/CLAUDE.md"]', "root cause: it lives in user scope (~/.claude/CLAUDE.md)");
lab.check(
  leadOnly.every(([, src]) => !SHARED_SCOPES.has(src.split(":")[0])),
  "every lead-only instruction comes from user or local scope; nothing committed differs",
);

lab.section("Fix: move the convention into the project CLAUDE.md (committed)");
moveToProject(people);
console.log(`  removed from lead's ~/.claude/CLAUDE.md; added under '## Tooling' in ./CLAUDE.md:\n    ${PROJECT_LINE}`);
const after = sessions(people);
for (const [name, res] of Object.entries(after)) console.log(`  ${name.padEnd(9)} ${JSON.stringify(NEEDLE).padEnd(24)} -> ${JSON.stringify(sources(res, NEEDLE))}`);
lab.check(
  Object.values(after).every((res) => JSON.stringify(sources(res, NEEDLE)) === '["project:./CLAUDE.md"]'),
  "both developers now get it, from exactly one place: the project CLAUDE.md",
);
lab.check(
  after.lead.allText().includes("Prefer `rg`") && !after.teammate.allText().includes("Prefer `rg`") && !after.lead.allText().includes("two-line summary"),
  "personal preferences stay personal: each developer still gets only their own ~/.claude/CLAUDE.md",
);
console.log("\nIn Claude Code, each developer runs /memory: the pnpm line should now show under the project file.");
