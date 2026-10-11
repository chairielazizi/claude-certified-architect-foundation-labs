# D1.7: Manage session state, resumption, and forking

**Domain 1: Agentic Architecture & Orchestration (27%)** · Task Statement 1.7
**Exam scenarios:** Developer Productivity with Claude (multi-day codebase investigations), Code Generation with Claude Code

## What the exam expects

| Knowledge | Skill |
|---|---|
| Named session resumption with `--resume <session-name>` continues a specific earlier conversation | Use `--resume` with session names to continue named investigations across work sessions |
| `fork_session` creates independent branches from a shared analysis baseline | Fork to explore two directions in parallel (two testing strategies, two refactoring approaches) from the same analysis |
| When you resume after code changes, the agent must be told which analysed files changed | Name the specific changed files for targeted re-analysis instead of asking for a full re-exploration |
| A new session seeded with a structured summary is more reliable than resuming with stale tool results | Resume when most of the prior context is still valid. Start fresh with an injected summary when the earlier tool results are stale |

## The pattern

```
registry[name] = { session_id, files: {path: sha256}, findings }      # written at the end of each work session

next work session:
    diff  = compare(registry[name].files, files on disk now)          # changed / added / deleted / unchanged
    stale = (changed + deleted) / analysed
      0%       -> resume as is                                         resume=sid        claude --resume <name>
      <= 50%   -> resume + "Since our last session these files
                  changed: ... Re-analyze only these."                 (targeted re-analysis)
      > 50%    -> NEW session whose first message is a structured
                  summary: still-valid findings, what to re-verify,
                  files to re-read. No old tool results.

explore alternatives from one baseline -> fork                         resume=sid, fork_session=True
                                                                       claude --resume <id> --fork-session
```

## Files

| File | What it shows |
|---|---|
| `python/workspace.py`, `typescript/workspace.ts` | The `auth/` package being investigated, plus the two edits made between work sessions (1 file changed, then a refactor). Recreated under `.lab-runtime/` on every run |
| `python/session_registry.py`, `typescript/sessionRegistry.ts` | `SessionRegistry` (name -> id, lineage, file hashes, findings), `diff_snapshot`, `choose_resume_strategy`, `build_change_message`, `build_structured_summary` |
| `python/investigator.py`, `typescript/investigator.ts` | Tools (`list_files`, `read_file`), the analysis stand-in, and a model-driven scripted investigator that reads only what each instruction asks for |
| `python/messages_sessions.py`, `typescript/messagesSessions.ts` | Messages API analog: history = session. Resume = reload and append. Fork = deep copy. Fresh = new history seeded with the summary |
| `python/agent_sdk_sessions.py`, `typescript/agentSdkSessions.ts` | Agent SDK path: `query()` -> `ResultMessage.session_id`, `rename_session`, `resume=sid`, `fork_session=True` (TS `{ resume, forkSession }`). Offline it runs against a stand-in with the same session semantics |

## Run it

```bash
# from the repo root
python "D1.7 - Session State Resumption and Forking/python/messages_sessions.py"
python "D1.7 - Session State Resumption and Forking/python/agent_sdk_sessions.py"
npx tsx "D1.7 - Session State Resumption and Forking/typescript/messagesSessions.ts"
npx tsx "D1.7 - Session State Resumption and Forking/typescript/agentSdkSessions.ts"

# real sessions (costs tokens). Afterwards, from .lab-runtime/agent_sdk/workspace: claude --resume auth-investigation
python "D1.7 - Session State Resumption and Forking/python/agent_sdk_sessions.py" --live
```

Expected offline output (abridged):

```
--- Work session 2: resume by name with a targeted change notice ---
  decision: resume (1/4 analysed files changed (25%): prior context is mostly valid, ...)
  Since our last session these files changed:
  - auth/tokens.py (modified)
  Re-analyze only these files and update your findings for them. ...
  re-read: ['auth/tokens.py']
  [PASS] targeted re-analysis: only the changed file was re-read
--- Fork: two testing strategies from the shared analysis baseline ---
  strategy-a -> sess-002 (forked from sess-001)
  strategy-b -> sess-003 (forked from sess-001)
  [PASS] both branches share the 10-message baseline prefix
  [PASS] branches are independent: an edit in A does not leak into B or the baseline
--- Work session 3: resume or start fresh? ---
  decision: fresh (3/4 analysed files changed or were deleted (75% > 50%): ...)
  STRUCTURED SUMMARY of previous session 'auth-investigation' (sess-001). It replaces that transcript.
  Still-valid findings (file unchanged since it was analysed):
  - auth/tokens.py: signing secret is hard-coded in source
  ...
  [PASS] the fresh session holds only its own tool results, none from earlier sessions
```

## CLI cheatsheet

| Goal | Claude Code CLI | Agent SDK |
|---|---|---|
| Start a named session | `claude -n auth-investigation` | `query(...)`, take `ResultMessage.session_id`, then `rename_session(sid, "auth-investigation")` (Python) |
| Name the current session | `/rename auth-investigation` | `rename_session(sid, title)` |
| Resume a specific session by name or id | `claude --resume auth-investigation` | `ClaudeAgentOptions(resume=sid)` / `{ resume: sid }` |
| Continue the most recent session in this directory | `claude --continue` (`-c`) | `continue_conversation=True` / `{ continue: true }` |
| Branch from a session | `claude --resume <id> --fork-session` | `ClaudeAgentOptions(resume=sid, fork_session=True)` / `{ resume: sid, forkSession: true }`, or the `fork_session(sid, up_to_message_id=...)` helper |
| Resume non-interactively (scripts, CI) | `claude -p "..." --resume <id>` | same options with `query()` |

## Resume or start fresh?

| Situation | Do this | Why |
|---|---|---|
| Nothing changed | Resume | All earlier tool results still describe the code |
| A few analysed files changed (here 1 of 4) | Resume, then say exactly which files changed and ask for re-analysis of only those | The rest of the context is valid. Naming the files avoids both re-exploring everything and silently trusting old reads |
| Most analysed files changed or were deleted (here 3 of 4) | New session, first message = structured summary | The old transcript is now mostly *wrong evidence* that still looks authoritative |
| Want to compare two approaches | Fork from the shared baseline | Each branch is independent, so the strategies do not contaminate each other |

Why a fresh session with a summary beats resuming with stale results. After the refactor, the old transcript still shows `password == stored["password"]` and a `middleware.py` that no longer exists. A resumed agent can report bugs that are already fixed, or reason from deleted code, because tool results in context read like facts. The structured summary keeps the conclusions that still hold (the `tokens.py` secret), marks the rest for re-verification, lists the files to read, and carries no stale tool output. It is also far smaller than the transcript it replaces.

## Exam traps

- **Resuming after code changes without saying what changed.** The agent trusts its earlier reads. Tell it the specific files ("Since our last session these files changed: ...") for targeted re-analysis. Do not answer this with "re-read the whole codebase" either: that wastes the context you resumed for.
- **"Always resume, it keeps more context."** When most of the earlier tool results are stale, more context means more wrong context. Start fresh and inject a structured summary.
- **Fork vs resume twice.** Resuming the same session for strategy A and then for strategy B piles both into one history. A fork gives each strategy its own branch from the same baseline, and the original stays untouched.
- **Fork branches the conversation, not the files.** Edits made in one branch land on the same disk the other branch reads. Use separate git worktrees or branches if the branches will write code.
- **`--continue` is not `--resume <name>`.** `--continue` picks the most recent session in the current directory. A named investigation is resumed with `--resume auth-investigation`.
- **On the Messages API a session is just the history you store.** Resuming means re-sending it. A homegrown fork must deep-copy it: the demo shows a shallow copy leaking an edit into the baseline.

## SDK notes

- Get the id from `ResultMessage.session_id` (TS: the `result` message's `session_id`; the `system`/`init` message carries it too).
- `fork_session=True` (TS `forkSession: true`) only applies together with `resume`. It produces a new session id and leaves the original transcript unchanged. A plain `resume` continues the same session. The offline stand-in models this, and `--live` prints the ids so you can confirm it.
- The Python SDK's session helpers (`rename_session`, `fork_session`, `list_sessions`, `get_session_info`, `tag_session`) find sessions by project directory, so pass `directory=` (here the workspace used as `cwd`). The TS twin keeps the name only in its own registry, because a TS rename helper was not verified for this lab.
- `fork_session(session_id, up_to_message_id=...)` can branch from an earlier point in the conversation without running a query.

## Try this next

1. Set `STALE_THRESHOLD = 0.25` and rerun. Work session 2 now starts fresh as well. When is the extra re-reading worth it?
2. Run `agent_sdk_sessions.py --live`. Then `cd` into `.lab-runtime/agent_sdk/workspace`, run `claude --resume auth-investigation`, and ask "what is still open in tokens.py?".
3. Use the Python helper `fork_session(sid, up_to_message_id=...)` to branch from *before* the change notice, and compare that branch's view of `tokens.py` with the resumed session's view.
