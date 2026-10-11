# D3.4: Determine when to use plan mode vs direct execution

**Domain 3: Claude Code Configuration & Workflows (20%)** · Task Statement 3.4
**Exam scenarios:** Code Generation with Claude Code, Developer Productivity with Claude

## What the exam expects

| Knowledge | Skill |
|---|---|
| Plan mode is for complex tasks: large-scale changes, multiple valid approaches, architectural decisions, multi-file modifications | Choose plan mode for tasks with architectural implications: microservice restructuring, a library migration touching 45+ files, choosing between integration approaches that need different infrastructure |
| Direct execution fits simple, well-scoped changes, such as adding one validation check to one function | Choose direct execution for well-understood changes with clear scope: a single-file bug fix with a clear stack trace, adding a date validation conditional |
| Plan mode lets you explore the codebase safely and design before committing to changes, which prevents costly rework | Use the Explore subagent for verbose discovery so the context window doesn't fill up during multi-phase tasks |
| The Explore subagent isolates verbose discovery output and returns a summary, which preserves the main conversation's context | Combine plan mode for investigation with direct execution for implementation, for example plan a library migration and then execute the plan |

## The pattern

```
task arrives -> route(task)                         explicit criteria, see task_router
  direct execution                                  1 file, clear stack trace / one conditional
  plan mode                                         many files, architecture, options, infra, unclear
     phase 1  permission_mode="plan"                read-only; no Write/Edit/Bash
              agents={"dependency-explorer": read-only AgentDefinition}   (or built-in Explore)
              -> plan (approach + rejected alternative + files + verification)
     human approves the plan
     phase 2  permission_mode="acceptEdits"         prompt = "<approved_plan>...</approved_plan>"
              -> execute exactly the plan, run tests
```

In the interactive CLI: **Shift+Tab** cycles permission modes (default -> auto-accept edits -> plan),
`/plan` enters plan mode, and `claude --permission-mode plan` starts a session in it.

## Files

| File | What it shows |
|---|---|
| `python/task_router.py`, `typescript/taskRouter.ts` | `route(task)` uses explicit signals (files affected, architectural decision, multiple approaches, infrastructure choice, unclear requirements, stack trace, single function) and returns a mode plus reasons. It runs on the exam's own examples |
| `python/plan_then_execute.py`, `typescript/planThenExecute.ts` | The Agent SDK flow. Phase 1 uses `permission_mode="plan"` with a read-only explorer subagent. Phase 2 uses `permission_mode="acceptEdits"` with the approved plan injected. Live mode calls `query()`. Offline mode builds the real option objects and runs a scripted handoff on a copy of `sample-repo/` |
| `python/explore_subagent.py`, `typescript/exploreSubagent.ts` | Measures main-context cost for discovery done inline vs in a subagent, on a generated 48-caller codebase |
| `sample-repo/` | A tiny billing service with a deprecated `common/legacy_dates.py`, four callers, and behavior tests that must pass before and after the migration |

## Run it

```bash
python "D3.4 - Plan Mode vs Direct Execution/python/task_router.py"
python "D3.4 - Plan Mode vs Direct Execution/python/plan_then_execute.py"
python "D3.4 - Plan Mode vs Direct Execution/python/explore_subagent.py"
npx tsx "D3.4 - Plan Mode vs Direct Execution/typescript/taskRouter.ts"
npx tsx "D3.4 - Plan Mode vs Direct Execution/typescript/planThenExecute.ts"
npx tsx "D3.4 - Plan Mode vs Direct Execution/typescript/exploreSubagent.ts"

# real Agent SDK run (needs the Claude Code runtime + credentials; edits only .lab-runtime/workspace)
python "D3.4 - Plan Mode vs Direct Execution/python/plan_then_execute.py" --live
```

Expected offline output (abridged):

```
  Restructure the monolith into microservices
    -> PLAN MODE
       - ~60 files: a multi-file change; map dependencies before editing
       - architectural decision (service boundaries / module dependencies)
  Fix TypeError in parse_invoice (stack trace points at invoices.py:42)
    -> DIRECT EXECUTION

--- Phase 1 - plan mode (read-only investigation) ---
  ClaudeAgentOptions(permission_mode='plan', allowed_tools=['Read', 'Grep', 'Glob', 'Agent'], disallowed_tools=['Bash', 'Edit', ...])
  [PASS] phase 1 has no write tools: none allowed, all explicitly disallowed
  [PASS] planning changed nothing on disk
--- Phase 2 - direct execution of the approved plan (acceptEdits) ---
  [PASS] phase 2's prompt carries the approved plan verbatim
  [PASS] sample-repo tests still pass after the migration

  A. discovery in the main conversation : ~ 33169 tokens stay in main context
  B. discovery in the Explore subagent  : ~   629 tokens come back as a summary
```

## Routing criteria

| Signal | Points to | Exam example |
|---|---|---|
| More than ~3 files, dependencies to map | plan | library migration affecting 45+ files |
| Service boundaries / module dependencies | plan | monolith -> microservices |
| Several valid approaches | plan | which migration strategy, which integration |
| Approaches differ in infrastructure | plan | polling job vs webhook endpoint + queue |
| Unclear requirements or unknown cause | plan (investigate first) | "checkout sometimes fails" |
| Clear stack trace, single function, clear spec | direct | single-file bug fix; add a date validation conditional |

## Exam traps

- **Sample question 5.** Restructuring a monolith into microservices, with changes across dozens of files and decisions about service boundaries, calls for (A): enter plan mode, explore, understand dependencies, and design before changing anything. (B), "let the implementation reveal the boundaries", risks costly rework when dependencies turn up late. (C), direct execution with detailed upfront instructions, assumes you already know the right structure without exploring. (D), start direct and switch only if it gets complex, ignores that the complexity is already stated in the requirements.
- **Plan mode is not "always safer".** For a one-line fix with a clear stack trace, planning only adds overhead. The exam rewards matching the mode to the task.
- **Plan, then execute.** The two modes combine. Plan read-only, get the plan approved, then switch to direct execution (`acceptEdits`) and implement exactly that plan. Pass the plan into the execution prompt verbatim, because a fresh session does not remember the plan.
- **Explore is about context, not permissions.** The subagent's reads and greps fill *its* context window and it returns a summary. Without it, a 48-file discovery leaves about 33k tokens in the main conversation before the first edit.
- **The tool is "Agent" now.** The exam calls the subagent-spawning tool "Task". Current SDKs name it `Agent` ("Task" still works as an alias), so `allowed_tools` lists `"Agent"`.

## SDK notes

- `permission_mode` values (Python): `"default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions" | "auto"`. TypeScript uses `permissionMode`.
- The Agent SDK documents an `ExitPlanMode` tool whose input carries the `plan`. The live runner captures that input when it appears and otherwise falls back to the final `result` text. The docs don't state explicitly that plan mode always ends with an `ExitPlanMode` call.
- Phase 1 sets `disallowed_tools` to the write tools on top of plan mode. That is redundant by design: the check proves the planner *cannot* edit, which doesn't depend on how the model behaves.

## Try this next

1. Add a fifth caller that imports `legacy_dates` under an alias (`import common.legacy_dates as ld`). Watch the scripted explorer miss it, then extend `discover_callers` so the plan covers it. This is the kind of thing plan mode is supposed to find *before* editing.
2. Add `effort="low"` to the phase 1 options and compare plan quality in `--live` runs.
3. Write a `route()` case for "upgrade the ORM, 30 files, one obvious approach". Decide whether file count alone should force plan mode, and adjust `MULTI_FILE_THRESHOLD`.
