# D3.2: Create and configure custom slash commands and skills

**Domain 3: Claude Code Configuration & Workflows (20%)** · Task Statement 3.2
**Exam scenarios:** Code Generation with Claude Code, Developer Productivity with Claude

## What the exam expects

| Knowledge | Skill |
|---|---|
| Project commands in `.claude/commands/` are shared through version control. User commands in `~/.claude/commands/` are personal | Create project-scoped commands in `.claude/commands/` so the whole team gets them on clone or pull |
| Skills live in `.claude/skills/<name>/SKILL.md`, with frontmatter such as `context: fork`, `allowed-tools` and `argument-hint` | Use `context: fork` to isolate verbose output (codebase analysis) or exploratory context (brainstorming) from the main session |
| `context: fork` runs the skill in an isolated subagent, so its output doesn't pollute the main conversation | Configure `allowed-tools` to control tool access while the skill runs, for example file read/write only for scaffolding |
| Personal variants go in `~/.claude/skills/` under a **different name**, so teammates aren't affected | Use `argument-hint` to tell developers which parameters to pass when they invoke a skill without them |
| | Choose between a skill (on-demand, task-specific workflow) and CLAUDE.md (always-loaded universal standards) |

## The pattern

```
/review security            -> .claude/commands/review.md           project command (git)
/scaffold-component A dir   -> .claude/skills/scaffold-component/   project skill   (git)
/review-strict              -> ~/.claude/skills/review-strict/      personal skill  (only you)

SKILL.md
  ---
  name: codebase-analysis
  description: ...when to use it...        <- Claude reads this to decide when to auto-invoke
  argument-hint: "[path] [question]"       <- shown when you type the command
  context: fork                            <- run in an isolated subagent; only the result comes back
  agent: Explore                           <- which subagent (default general-purpose)
  allowed-tools: Read Grep Glob            <- pre-approved while the skill runs
  disable-model-invocation: true           <- only a human may trigger it (side effects)
  ---
  body with $ARGUMENTS, $0 $1 (0-based), $ARGUMENTS[N], $name, !`shell injection`

same /name in several places:  skill > command;  personal skill > project skill
```

## Files

| File | What it shows |
|---|---|
| `example-repo/.claude/commands/review.md` | The team's `/review` checklist. It uses `$ARGUMENTS` for an optional focus and `` !`git diff --stat main...HEAD` `` to inject the change summary |
| `example-repo/.claude/skills/codebase-analysis/SKILL.md` | `context: fork` + `agent: Explore` + `allowed-tools: Read Grep Glob`. Verbose discovery stays in the subagent and only the summary returns |
| `example-repo/.claude/skills/scaffold-component/SKILL.md` | `argument-hint: "[ComponentName] [directory]"`, uses `$0` and `$1`, `allowed-tools: Read Write`, `disable-model-invocation: true` |
| `example-repo/.claude/skills/brainstorm-alternatives/SKILL.md` | `context: fork` to keep exploratory dead ends out of the main session (default `general-purpose` agent) |
| `example-repo/.claude/settings.json` | `permissions.deny` rules. These, not `allowed-tools`, are what actually block destructive commands |
| `example-repo/CLAUDE.md` | Always-on standards, plus a list of the on-demand workflows |
| `user-home-example/.claude/commands/my-standup.md` | A personal command (only this developer has `/my-standup`) |
| `user-home-example/.claude/skills/review-strict/SKILL.md` | A personal variant under a different name. It reads the team checklist, then adds stricter rules |
| `python/skill_inspector.py`, `typescript/skillInspector.ts` | Discovery per scope, frontmatter validation, collision resolution, forked and tool-access report, permission simulation, placeholder rendering (library + demo) |
| `python/invoke_skill.py`, `typescript/invokeSkill.ts` | What Claude receives for `/name args`: 0-based positionals, the argument-hint prompt, `$ARGUMENTS`, shell injection, named args, quoting, `\$`, the `ARGUMENTS:` fallback |
| `python/skill_or_claude_md.py`, `typescript/skillOrClaudeMd.ts` | `decide()`: explicit criteria for CLAUDE.md vs path rule vs skill (+ fork / allowed-tools), run on eight examples |

## Run it

```bash
python "D3.2 - Custom Slash Commands and Skills/python/skill_inspector.py"
python "D3.2 - Custom Slash Commands and Skills/python/invoke_skill.py"
python "D3.2 - Custom Slash Commands and Skills/python/skill_or_claude_md.py"
npx tsx "D3.2 - Custom Slash Commands and Skills/typescript/skillInspector.ts"
npx tsx "D3.2 - Custom Slash Commands and Skills/typescript/invokeSkill.ts"
npx tsx "D3.2 - Custom Slash Commands and Skills/typescript/skillOrClaudeMd.ts"

# the real thing
cd "D3.2 - Custom Slash Commands and Skills/example-repo" && claude    # then type / to see the commands
```

No model is called. The inspector simulates Claude Code's discovery and substitution rules.
Expected output (abridged):

```
  /name                     kind     scope     runs                       pre-approved tools
  /review                   command  project   inline (main context)      Read Grep Glob Bash(git diff *) Bash(git log *)
  /codebase-analysis        skill    project   forked -> Explore          Read Grep Glob
  /scaffold-component       skill    project   inline (main context)      Read Write
  /review-strict            skill    personal  inline (main context)      Read Grep Glob Bash(git diff *)
  lead     /review               -> skill (personal)   project command shadowed: a skill beats a command ...
  teammate /review               -> command (project)
> /scaffold-component
  (not sent to Claude) /scaffold-component needs 2 argument(s). Usage: /scaffold-component [ComponentName] [directory]
  [PASS] $0 -> first argument, $1 -> second argument
```

## allowed-tools: what the exam says vs what Claude Code does

| | Exam framing | Current Claude Code docs |
|---|---|---|
| `allowed-tools: Read Write` | "restrict tool access during skill execution", for example file writes only, so the skill can't run destructive commands | **Pre-approves** the listed tools for the turn that invokes the skill (no permission prompt). Other tools stay callable and go through your normal permission settings |
| Hard-blocking `rm -rf` | `allowed-tools` without Bash | A `permissions.deny` rule in `.claude/settings.json`, or `context: fork` with a read-only agent (Explore/Plan has no Write/Edit) |

Answer exam questions with the exam framing: `allowed-tools` is the frontmatter field for scoping a skill's tools. In a real repository, pair it with deny rules, as `example-repo/.claude/settings.json` does. Section 5 of the inspector demonstrates both behaviors.

## Exam traps

- **Sample question 4: where does a team `/review` command go?** In `.claude/commands/` in the repository (A). It is version-controlled, so everyone gets it on clone or pull. `~/.claude/commands/` (B) is personal. CLAUDE.md (C) holds instructions, not command definitions. A `.claude/config.json` commands array (D) does not exist.
- **Placeholders are 0-based.** `$0` is the first argument and `$1` the second, and `$ARGUMENTS[0]` equals `$0`. An exam option, or an old blog post, that uses `$1` for the first argument is describing the old convention. Arguments use shell-style quoting, and `\$` is a literal dollar.
- **Same name, different scopes.** A skill beats a command with the same name, and a personal skill beats a project skill with the same name. Copying the team's `/review` into `~/.claude/skills/review/` silently swaps the team checklist out for your own copy, so you stop receiving team updates. Use a distinct name such as `review-strict`. Teammates are never affected by your `~/.claude`, but you are.
- **`context: fork` is about context hygiene.** Use it when the skill's work is noisy (reading 40 files, brainstorming dead ends) and only the conclusion matters. A fork can't see the main conversation's history, so the skill body must be self-contained.
- **Skills vs CLAUDE.md.** A rule every task must follow ("use pnpm") must not be a skill, because skills load only when invoked. A procedure with steps and an output format ("run the review checklist") must not sit in CLAUDE.md, where it costs tokens in every session. Conventions for certain file types belong in `.claude/rules/` with `paths:` (D3.3, sample question 6, option C explains why skills are wrong there).
- **`argument-hint` is a hint.** Claude Code shows it while you type the command. It does not validate input. The inspector in this lab goes further and refuses to render until the required slots are filled. Write your skill bodies to handle a missing argument (for example "if no path is given, ask for one").

## SDK notes

- `.claude/commands/` is the older format and still works. A command and a skill with the same name both create the same `/name`. New work should prefer skills, which add a directory for supporting files, `context: fork`, and `agent`.
- Precedence between a personal **command** and a project **command** with the same name is not documented. The inspector flags it as AMBIGUOUS instead of guessing.
- In the Agent SDK, project skills and commands are available when `setting_sources` includes `"project"` (it loads `.claude/`).

## Try this next

1. Add `.claude/agents/security-reviewer.md` (frontmatter `name`, `description`, `tools: Read, Grep, Glob`), then point a new forked skill at `agent: security-reviewer`. The validator stops reporting "unknown agent".
2. Give `codebase-analysis` an `arguments: [target]` field and switch the body to `$target`. Then run `/codebase-analysis` with no arguments and check that the hint appears.
3. Add `"Write(src/api/*)"` to the deny list in a copy of `settings.json`. Confirm that `decide_permission("Write(src/api/Foo.tsx)", scaffold, settings)` returns deny even though `Write` is pre-approved, because deny rules are checked first.
