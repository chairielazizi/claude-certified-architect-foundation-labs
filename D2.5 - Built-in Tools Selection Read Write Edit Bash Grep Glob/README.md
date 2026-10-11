# D2.5: Select and apply built-in tools (Read, Write, Edit, Bash, Grep, Glob) effectively

**Domain 2: Tool Design & MCP Integration (18%)** · Task Statement 2.5
**Exam scenarios:** Developer Productivity with Claude, Code Generation with Claude Code

## What the exam expects

| Knowledge | Skill |
|---|---|
| Grep searches file contents for patterns (function names, error messages, import statements) | Use Grep to search code content across a codebase (all callers of a function, where an error message comes from) |
| Glob matches file paths by name or extension pattern | Use Glob to find files matching a naming pattern (`**/*.test.tsx`) |
| Read/Write handle whole files. Edit makes targeted changes using unique text matching | Read the full file, then Write it back, when Edit can't find unique anchor text |
| When Edit fails because the match isn't unique, Read + Write is the reliable fallback | Build understanding incrementally: Grep for entry points, then Read to follow imports and trace flows. Don't read every file upfront |
| | Trace function usage across wrapper modules: first find all exported names, then search for each one |

## The pattern

```
"where is X used / raised / imported?"     -> Grep  (contents)
"which files are named / end in ...?"      -> Glob  (paths: **/*.test.tsx)
"what does this file do?"                  -> Read  (only files on the path you are tracing)
"change this one unique line"              -> Edit  (old_string must match exactly once)
Edit fails (0 or >1 matches)               -> longer unique anchor, or Read + modify + Write
"create / fully rewrite a file"            -> Write
"run tests / git / build"                  -> Bash

trace usage through wrappers:
  names = {refund}; Grep "import .*\brefund\b" -> 'refund as issue_refund' -> names += issue_refund
  repeat until no new names; then Grep "\b<name>\(" for every name
```

## Files

| File | What it shows |
|---|---|
| `sample_repo/` | A small fake codebase: an entry point (`app/main.py`), wrapper modules (`app/payments/__init__.py` re-exports `charge` and aliases it as `capture_payment`; `app/refunds.py` does `from .core import refund as issue_refund`), distinctive error messages, tests spread around (`*.test.tsx` in two web folders, `test_*.py` in `tests/` and next to the code), and `config/settings.py` with duplicated lines |
| `python/mini_tools.py`, `typescript/miniTools.ts` | `grep`, `glob` (with `**`), `read`, `write`, `edit` (raises on 0 or >1 matches) over a workspace, with a call log |
| `python/code_nav.py`, `typescript/codeNav.ts` | Import parsing (`from m import a as b`) and module resolution, which is what the agent works out after each Read |
| `python/tool_selection.py`, `typescript/toolSelection.ts` | Demo 1: the task-to-tool table, with each Grep/Glob/Read task run on the sample repo |
| `python/incremental_exploration.py`, `typescript/incrementalExploration.ts` | Demo 2: Grep for the entry point, then Read and follow imports to where the card is charged. 4 of 21 files read |
| `python/trace_wrappers.py`, `typescript/traceWrappers.ts` | Demo 3: a naive Grep for `refund(` misses 3 call sites. Collecting aliases and re-exports first finds them all |
| `python/edit_fallback.py`, `typescript/editFallback.ts` | Demo 4: Edit fails on an ambiguous anchor and on a missing anchor. Read + Write changes exactly one line. A longer unique anchor also works |
| `python/explore_agent.py`, `typescript/exploreAgent.ts` | **Live only.** An Agent SDK agent restricted to `tools=["Read", "Grep", "Glob"]`, with an incremental-exploration prompt |

## Run it

```bash
python "D2.5 - Built-in Tools Selection Read Write Edit Bash Grep Glob/python/tool_selection.py"
python "D2.5 - Built-in Tools Selection Read Write Edit Bash Grep Glob/python/incremental_exploration.py"
python "D2.5 - Built-in Tools Selection Read Write Edit Bash Grep Glob/python/trace_wrappers.py"
python "D2.5 - Built-in Tools Selection Read Write Edit Bash Grep Glob/python/edit_fallback.py"
npx tsx "D2.5 - Built-in Tools Selection Read Write Edit Bash Grep Glob/typescript/traceWrappers.ts"

# the real thing: Claude Code exploring sample_repo with read-only built-in tools
python "D2.5 - Built-in Tools Selection Read Write Edit Bash Grep Glob/python/explore_agent.py" --live
```

Expected offline output (abridged):

```
--- Steps 2-5: Read and follow imports ---                     (incremental_exploration)
  app/main.py: checkout_cart imported from app.checkout -> app/checkout.py
  app/checkout.py: charge imported from app.payments -> app/payments/__init__.py
  app/payments/__init__.py: charge imported from ._stripe_adapter -> app/payments/_stripe_adapter.py
  app/payments/_stripe_adapter.py: def charge(...)  <- defined here
  files read: 4/21  chars read: 1713/5167 (33%)
--- Who calls refund()? ---                                    (trace_wrappers)
  naive Grep '\brefund\(':  ['app/jobs/nightly.py:9']
  names found from import lines: ['issue_refund', 'refund']
  missed by the naive search: ['app/admin/tools.py:9', 'app/checkout.py:13', 'tests/test_refunds.py:5']
--- 1. Edit with an ambiguous anchor ---                       (edit_fallback)
  EditError: old_string matches 2 places in config/settings.py; provide more context to make it unique
--- 3. Fallback: Read the full file, modify in memory, Write it back ---
  changed lines: [('    "timeout_seconds": 30,', '    "timeout_seconds": 45,')]
```

`edit_fallback` works on a scratch copy in `.lab-runtime/` (gitignored), so `sample_repo/` never changes.

## Tool selection table

| Task | Tool | Why |
|---|---|---|
| Find all callers of `charge()` | Grep `\bcharge\(` | content search. Also grep every alias (see below) |
| Find `**/*.test.tsx` test files | Glob | path pattern. The contents don't matter |
| Find where "Refund window expired" is raised | Grep | an error message is file content |
| Find `test_*.py` anywhere | Glob `**/test_*.py` | names, in several directories |
| Find modules importing from `app.payments` | Grep `from app\.payments import` | import statements are content |
| Understand `app/checkout.py` | Read | you need the whole file |
| Change one unique line | Edit | targeted, but needs a unique `old_string` |
| Create a file / replace a whole file | Write | full contents |
| Run the tests, `git log` | Bash | execution, not file access |

## Exam traps

- **Grep vs Glob:** Glob never looks inside files, and Grep doesn't match file names. "Find all test files" is Glob. "Find all files that call X" is Grep.
- **Reading everything upfront** fills the context with irrelevant code. Start from a Grep hit (entry point, error message, function name) and Read only what the trace leads to. Here that is 33% of the repo's text, and the gap grows with real repositories. Large-codebase context strategy is in [D5.4](<../D5.4 - Context Management in Large Codebase Exploration/README.md>).
- **Wrapper modules hide callers.** `from .core import refund as issue_refund` means a Grep for `refund(` misses every `issue_refund(` caller, and `payments/__init__.py` re-exports `charge` as `capture_payment`. Collect all exported names and aliases first, then search for each one.
- **Edit needs a unique anchor.** If `old_string` appears twice (identical config blocks, repeated boilerplate) or not at all (whitespace differs), Edit fails. Widen the anchor with surrounding unique context. The guaranteed fallback is Read the full file, change it in memory, and Write the whole file back.
- Write replaces the *entire* file. Use it for new files or deliberate full rewrites, not as a substitute for small edits on files you haven't Read.
- Restricting an exploration agent to `Read`, `Grep`, `Glob` (Agent SDK `tools=[...]`) makes it read-only by construction. That is safer than relying on the prompt.

## SDK notes

- Agent SDK: `tools=[...]` limits which built-in tools exist. `allowed_tools=[...]` auto-approves tools without a permission prompt. `disallowed_tools` removes tools. The built-in Explore subagent (read-only) is another way to keep verbose discovery out of the main context.
- The real Grep tool (ripgrep) also supports file-type filters, context lines, and output modes. The real Edit has a `replace_all` option for deliberate multi-replacements. The mini tools keep only the behaviour that drives tool choice.

## Try this next

1. Add `from app.payments import charge as pay` in a new `app/subscriptions.py` and call `pay(...)`. Re-run `trace_wrappers` and confirm the fixpoint loop picks up the new alias.
2. Make the two settings blocks differ in indentation and see which Edit anchors become unique.
3. Run `explore_agent.py --live` and compare its Read count with the 4 files the scripted trace needed.
