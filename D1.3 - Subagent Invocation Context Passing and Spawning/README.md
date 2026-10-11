# D1.3: Configure subagent invocation, context passing, and spawning

**Domain 1: Agentic Architecture & Orchestration (27%)** · Task Statement 1.3
**Exam scenarios:** Multi-Agent Research System, Developer Productivity with Claude

## What the exam expects

| Knowledge | Skill |
|---|---|
| The Task tool spawns subagents, and a coordinator's `allowedTools` must include it (it is now named **`Agent`**, see SDK notes) | Pass the complete findings from earlier agents directly in the subagent's prompt, e.g. search results and document analysis handed to the synthesizer |
| Subagents do **not** inherit the parent's context or share memory between invocations, so context must be passed explicitly in the prompt | Use structured data that keeps content separate from metadata (source URL, document name, page) so attribution survives the handoff |
| `AgentDefinition`: description, system prompt and tool restrictions for each subagent type | Spawn parallel subagents by emitting **several** Agent calls in **one** coordinator response, not one per turn |
| Fork-based sessions for exploring divergent approaches from a shared baseline | Write coordinator prompts that state research goals and quality criteria, not step-by-step procedures |

## The pattern

```
ClaudeAgentOptions(
  system_prompt = goals + quality criteria          # not "Step 1 ... Step 4"
  allowed_tools = ["Agent", ...]                     # exam: "Task"; without it, no delegation
  agents = {
    "web-researcher": AgentDefinition(description, prompt, tools=["WebSearch","WebFetch"], model="inherit"),
    "doc-analyst":    AgentDefinition(..., tools=["Read","Grep","Glob"]),
    "synthesizer":    AgentDefinition(..., tools=["Read"]),            # no web: least privilege
  })

coordinator turn 1:  Agent(web, music) | Agent(docs, music) | Agent(web, vfx) | Agent(docs, vfx)   <- ONE response
                     -> run concurrently, return 4 tool_results in ONE user message
coordinator turn 2:  Agent(synthesizer, prompt = <findings>[ {content:{claim,evidence},
                                                             metadata:{source_url,document_name,page,publication_date}} ...]</findings>)
coordinator turn 3:  final answer
```

## Files

| File | What it shows |
|---|---|
| `python/agent_definitions.py`, `typescript/agentDefinitions.ts` | The coordinator prompt (goals and criteria), a procedural anti-pattern prompt, three subagent specs, `build_options()` returning `ClaudeAgentOptions` / `Options`, and `is_delegation()` matching `"Agent"` or `"Task"` |
| `python/research_coordinator.py`, `typescript/researchCoordinator.ts` | Offline it prints and checks the options, then replays a recorded SDK message stream through `describe_message()`, which detects delegations and subagent-internal messages via `parent_tool_use_id`. With `--live` it runs `query()` and prints every delegation and the final result |
| `python/context_passing.py`, `typescript/contextPassing.ts` | The same four findings handed to the synthesizer in two ways: a **prose recap** (sources lost) and **complete JSON** (content and metadata kept separate). Checks prove which claims keep their source, and that two conflicting figures stay attributable |
| `python/parallel_spawning.py`, `typescript/parallelSpawning.ts` | A Messages-API simulation of the Agent tool with 0.3 s of latency per call. It compares 4 Agent calls in one response run concurrently, the same response run sequentially, and the one-call-per-turn anti-pattern, timing each |
| `fixtures/docs/*.md` | Two short fictional reports. In live mode the doc-analyst reads them (the agent's `cwd` is `fixtures/`) |

## Run it

```bash
# from the repo root
python "D1.3 - Subagent Invocation Context Passing and Spawning/python/research_coordinator.py"
python "D1.3 - Subagent Invocation Context Passing and Spawning/python/context_passing.py"
python "D1.3 - Subagent Invocation Context Passing and Spawning/python/parallel_spawning.py"
npx tsx "D1.3 - Subagent Invocation Context Passing and Spawning/typescript/researchCoordinator.ts"
npx tsx "D1.3 - Subagent Invocation Context Passing and Spawning/typescript/contextPassing.ts"
npx tsx "D1.3 - Subagent Invocation Context Passing and Spawning/typescript/parallelSpawning.ts"

# live: a real Agent SDK coordinator that spawns real subagents (needs the Claude Code runtime; costs tokens)
python "D1.3 - Subagent Invocation Context Passing and Spawning/python/research_coordinator.py" --live
```

Expected offline output (abridged):

```
--- Delegation events (offline replay of a recorded stream) ---
  DELEGATE via 'Agent' (toolu_A1) -> web-researcher: Music licensing news
  DELEGATE via 'Task' (toolu_A2) -> doc-analyst: VFX workforce study
  tool call Read  [inside subagent of toolu_A2]
  [PASS] delegations detected under both names, 'Agent' and 'Task'

--- BAD: prose summary in the synthesizer's prompt ---
  [PASS] ... but 0 of 4 claims are still tied to a source
--- GOOD: complete findings as JSON, content separate from metadata ---
  [PASS] 4 of 4 claims are still tied to their own source

--- A - all Agent calls in one response, run concurrently ---
Agent calls per coordinator turn: [4, 1, 0]
coordinator turns: 3   wall-clock: 1.56s
--- C - anti-pattern: one Agent call per coordinator turn ---
Agent calls per coordinator turn: [1, 1, 1, 1, 1, 0]
coordinator turns: 6   wall-clock: 3.47s
  [PASS] parallel spawning beat one Agent call per turn (1.56s vs 3.47s)
```

## Context handoff: bad vs good

| | Prose recap | Complete structured findings |
|---|---|---|
| Claims present | 4 / 4 | 4 / 4 |
| Claims still tied to their source | **0 / 4** | **4 / 4** |
| Conflicting 40% vs 28% VFX figures | both numbers, no way to tell which source says what | each figure keeps its URL or document and page |
| What the synthesizer can cite | nothing (or it invents citations) | every claim |

## Exam traps

- **"The subagent can see what the coordinator saw."** It can't. A subagent gets its `AgentDefinition.prompt` plus the prompt in the Agent call, and nothing else. It has no parent history and no memory of earlier invocations. "Pass findings directly in the prompt" is the correct answer, not "rely on shared context".
- **Summarising before handing off.** A prose recap looks tidy, but it destroys attribution. Pass **complete** findings as structured records with content separate from metadata. Then the synthesis can cite every claim and present conflicting figures side by side (see [D5.6](<../D5.6 - Information Provenance in Multi-Source Synthesis/README.md>)).
- **Parallelism happens inside one response.** Parallel spawning means several Agent `tool_use` blocks in **one** coordinator turn. Issuing one Agent call per turn serialises the work and adds a coordinator round trip for each subagent. Your executor must also run them concurrently: case B shows that one response executed sequentially loses most of the gain.
- **Dependent work still waits.** The synthesizer runs after research because it needs the results. Fan out only the independent tasks.
- **`allowedTools` without `"Agent"`/`"Task"`.** The coordinator then cannot delegate at all. Separately, each subagent's `tools` list should be least-privilege: the synthesizer gets no web tools (compare sample Q9's scoped `verify_fact` tool).
- **Procedural coordinator prompts.** "Step 1: search ... Step 2: read file X" hard-codes the path and leaves nothing to judge. State the goal and the quality criteria (attribution, coverage, conflicts) and let the coordinator decide how to meet them.

## SDK notes

- **`Task` -> `Agent`.** The exam says `Task`. Claude Code v2.1.63 renamed the tool to `Agent`, and `Task` remains an alias. The labs put `"Agent"` in `allowed_tools` and detect delegation with `name in ("Agent", "Task")`. The tool input has `subagent_type`, `description` and `prompt`.
- In the stream, messages generated inside a subagent have a non-null `parent_tool_use_id` (the id of the Agent call that spawned it). Top-level coordinator messages have `None`/`null`.
- `model="inherit"` makes the subagent use the coordinator's model. `tools` restricts the subagent. `allowed_tools` on the coordinator pre-approves tools so subagents are not blocked by permission prompts.
- **Fork-based sessions.** `fork_session=True` with `resume=<id>` (TS `forkSession: true`) branches a session from a shared analysis baseline, so you can explore two approaches without either one polluting the other. Covered in [D1.7](<../D1.7 - Session State Resumption and Forking/README.md>).
- `parallel_spawning` simulates the Agent tool on the Messages API to make timing measurable. In the real SDK, Claude Code runs the subagents of one turn concurrently for you.

## Try this next

1. Remove `"Agent"` from `allowed_tools` and run `research_coordinator.py --live`. The coordinator now has to do the research itself, or explain that it can't.
2. In `context_passing.py`, drop `page` from the metadata and extend `attribution_report` to treat a document finding without a page as unattributed.
3. Make the `doc-analyst` task in `parallel_spawning.py` depend on the web results (for example, "check the 40% figure against the reports"). Move it to a second fan-out turn and compare the timings.
