# D3.1: Configure CLAUDE.md files with appropriate hierarchy, scoping, and modular organization

**Domain 3: Claude Code Configuration & Workflows (20%)** · Task Statement 3.1
**Exam scenarios:** Code Generation with Claude Code, Developer Productivity with Claude, Claude Code for CI

## What the exam expects

| Knowledge | Skill |
|---|---|
| The hierarchy: user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md` or `./.claude/CLAUDE.md`), directory-level (subdirectory `CLAUDE.md`) | Diagnose hierarchy bugs, such as a new teammate missing instructions because they live in someone's user-level file |
| User-level files apply only to that user. `~/.claude/CLAUDE.md` is never shared through version control | Use `/memory` to check which memory files are loaded and explain behavior that differs across sessions or people |
| `@path` imports keep CLAUDE.md modular. Each package imports only the standards files it needs | Write package CLAUDE.md files that `@import` the relevant standards, based on what the maintainers know about that package |
| `.claude/rules/` holds topic files as an alternative to one monolithic CLAUDE.md | Split a large CLAUDE.md into `testing.md`, `api-conventions.md` and `deployment.md` |

## The pattern

```
who gets it        file                                      loads
-----------------  ----------------------------------------  -------------------------------------------
org (managed)      managed policy CLAUDE.md                  launch (not simulated here)
only you           ~/.claude/CLAUDE.md, ~/.claude/rules/      launch, every project       NOT in git
the team           ./CLAUDE.md or ./.claude/CLAUDE.md         launch (launch dir + every ancestor)
the team           .claude/rules/*.md   (no paths:)           launch, same priority as CLAUDE.md
only you, 1 repo   ./CLAUDE.local.md                          launch                      gitignored
the team           packages/x/CLAUDE.md (below launch dir)    ON DEMAND, when Claude touches a file in packages/x/

@path imports: relative to the IMPORTING file, up to 4 hops, never inside `code` or fenced blocks.
Everything is concatenated, broadest first. Nothing overrides anything.
```

## Files

| File | What it shows |
|---|---|
| `example-repo/CLAUDE.md` | The project file the team commits: layout, tooling, universal code standards, `@docs/standards/git-workflow.md` import. It mentions `` `@../../docs/standards/pci-dss.md` `` in backticks, which is not an import |
| `example-repo/.claude/rules/{testing,api-conventions,deployment}.md` | Topic files without `paths:`, so they always load. [D3.3](<../D3.3 - Path-Specific Rules for Conditional Convention Loading/README.md>) adds `paths:` |
| `example-repo/packages/payments/CLAUDE.md` | Imports `@../../docs/standards/pci-dss.md`, which imports `@logging.md` (2 hops, resolved next to pci-dss.md) |
| `example-repo/packages/web/CLAUDE.md` | Imports `@../../docs/standards/react.md`. The payments team never pays for React rules, and the web team never pays for PCI rules |
| `example-repo/CLAUDE.local.md.example` | Personal, per-checkout notes. Copy to `CLAUDE.local.md`, which is gitignored |
| `user-home-example/.claude/CLAUDE.md` | The lead's personal file. It contains the team convention "Use pnpm, never npm" by mistake |
| `user-home-teammate/.claude/CLAUDE.md` | A new teammate's personal file |
| `fixtures/CLAUDE.monolithic.md` | The "before" picture: one file holding every topic |
| `python/memory_resolver.py`, `typescript/memoryResolver.ts` | The resolver. Given a user home, a repo, a launch dir and the files Claude has touched, it computes load order, scope, imports, the depth limit, cycles and code-span exclusion, then prints a `/memory`-style listing |
| `python/diagnose_teammate.py`, `typescript/diagnoseTeammate.ts` | The new-teammate bug: find the instruction, see that its scope is `user`, move it to the project CLAUDE.md, re-check both developers |
| `python/split_claude_md.py`, `typescript/splitClaudeMd.ts` | Splits the monolith by `##` headings into `.claude/rules/`. The checks prove nothing was lost and that the output matches `example-repo/.claude/rules/` |

## Run it

```bash
python "D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/python/memory_resolver.py"
python "D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/python/diagnose_teammate.py"
python "D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/python/split_claude_md.py"
npx tsx "D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/typescript/memoryResolver.ts"
npx tsx "D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/typescript/diagnoseTeammate.ts"
npx tsx "D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/typescript/splitClaudeMd.ts"

# the real thing: open the sample repo in Claude Code and compare with the simulator
cd "D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/example-repo" && claude   # then: /memory
```

These labs simulate Claude Code's loading rules, so no model is called and `--live` changes nothing.
Expected output (abridged):

```
--- 2. Same session, after Claude reads packages/payments/src/money.ts ---
   1  user    ~/.claude/CLAUDE.md                     launch            ~90 tok
   2  project ./CLAUDE.md                             launch           ~442 tok
   3  project     @-> ./docs/standards/git-workflow.md import (1 hop)  ~106 tok
   4  rule    ./.claude/rules/api-conventions.md      launch           ~171 tok
   ...
   7  subdir  ./packages/payments/CLAUDE.md           on demand        ~137 tok  on demand: Claude touched ./packages/payments/src/money.ts
   8  subdir      @-> ./docs/standards/pci-dss.md     import (1 hop)   ~138 tok
   9  subdir          @-> ./docs/standards/logging.md import (2 hops)   ~87 tok

--- Diagnosis: where does each session get the instruction? ---
  lead      'Use pnpm, never npm'    -> ['user:~/.claude/CLAUDE.md']
  teammate  'Use pnpm, never npm'    -> MISSING
  [PASS] root cause: it lives in user scope (~/.claude/CLAUDE.md)
  ...
  [PASS] both developers now get it, from exactly one place: the project CLAUDE.md
```

## Where does an instruction belong?

| The instruction is... | Put it in | Why |
|---|---|---|
| A team convention ("use pnpm", "money is integer minor units") | `./CLAUDE.md` (or a `.claude/rules/` topic file) | Committed, so every clone and every CI job gets it |
| A team convention for one topic that has an owner (testing, API, deployment) | `.claude/rules/<topic>.md` | Small files with clear owners and reviewable diffs. Without `paths:` they still always load |
| Only relevant inside one package | `packages/<pkg>/CLAUDE.md`, importing the shared standard | Loads on demand, only when Claude works in that package |
| A long standards document several packages need | `docs/standards/x.md`, then `@import` it where needed | One source of truth. Each package opts in |
| Your personal style, for every project | `~/.claude/CLAUDE.md` | Only you. Never reaches teammates or CI |
| Your personal notes for this checkout (local ports, current epic) | `./CLAUDE.local.md` | Gitignored |

## Exam traps

- **"It works on my machine" is a scope problem.** When one developer gets behavior that another doesn't, look first for an instruction in `~/.claude/CLAUDE.md` or `CLAUDE.local.md`. `/memory` on both machines shows the difference. The fix is to move team conventions into a committed file. Asking teammates to copy your user file does not scale, and it drifts.
- **Subdirectory CLAUDE.md files are lazy.** `packages/payments/CLAUDE.md` is not in context at launch from the repo root. It loads when Claude reads, writes or edits a file in that directory. Ancestors of the launch directory, by contrast, always load at launch.
- **Imports resolve relative to the importing file**, not the working directory. `@logging.md` inside `docs/standards/pci-dss.md` means `docs/standards/logging.md`. The depth limit is 4 hops. Imports inside `` `code` `` or fenced blocks are ignored, so you can safely write `` `npm i @types/node` ``.
- **`.claude/rules/` without `paths:` is organization, not savings.** Those rules load at launch like CLAUDE.md, which the split demo's token check proves. Conditional loading needs `paths:` (D3.3).
- **Load order is not an override mechanism.** All files are concatenated. When two instructions contradict each other, Claude may follow either one, so resolve the conflict in the files.
- **CLAUDE.md is the wrong place for commands.** A shared `/review` command belongs in `.claude/commands/` (D3.2, sample question 4).

## SDK notes

- The first time Claude Code sees a project memory file importing a path **outside** the working directory, it asks you to approve those external imports. The simulator does not model that dialog.
- Agent SDK sessions choose which scopes load through `setting_sources` (`["user", "project", "local"]`). `["project"]` loads the repo's `CLAUDE.md` and `.claude/` but not the runner's `~/.claude`. That is useful in CI, where you don't want a build agent's home directory changing behavior.
- The simulator stops the ancestor walk at the repo root to stay inside the lab. Real Claude Code keeps walking up toward `/`, so a stray `CLAUDE.md` in a parent folder (for example `~/code/CLAUDE.md`) loads too. `/memory` would show it.

## Try this next

1. Add `@../../docs/standards/logging.md` to `packages/web/CLAUDE.md`, then resolve with `files_read` covering both packages. Note that the simulator lists `logging.md` once.
2. Add `paths: ["packages/payments/**/*"]` frontmatter to `.claude/rules/api-conventions.md`, re-run `memory_resolver.py`, and watch it move to the "not loaded" list. [D3.3](<../D3.3 - Path-Specific Rules for Conditional Convention Loading/README.md>) builds the matcher.
3. Put a contradiction in the lead's `CLAUDE.local.md` ("use npm here"), run the diagnosis, and write a check that flags instructions contradicting the project file.
