# Claude Certified Architect – Foundations: Hands-on Labs

Runnable **Python and TypeScript** labs, one folder per task statement in the
*Claude Certified Architect – Foundations* exam guide (exam code **CCAR-F**, v1.0, July 2026).
Each folder is named after its task statement (`D<domain>.<task> - <title>`). Each one has a README
that maps the code to the exam's *Knowledge of / Skills in* bullets, plus a working demo in each language.

## Exam blueprint

| Domain | Weight | Labs |
|---|---|---|
| 1. Agentic Architecture & Orchestration | 27% | D1.1 – D1.7 |
| 2. Tool Design & MCP Integration | 18% | D2.1 – D2.5 |
| 3. Claude Code Configuration & Workflows | 20% | D3.1 – D3.6 |
| 4. Prompt Engineering & Structured Output | 20% | D4.1 – D4.6 |
| 5. Context Management & Reliability | 15% | D5.1 – D5.6 |

The exam draws 4 of 6 scenarios: Customer Support Resolution Agent, Code Generation with Claude Code,
Multi-Agent Research System, Developer Productivity with Claude, Claude Code for CI, Structured Data Extraction.
Every lab README lists the scenarios it supports.

## Lab index

### Domain 1: Agentic Architecture & Orchestration
- [D1.1 Agentic loops for autonomous task execution](<D1.1 - Agentic Loops for Autonomous Task Execution/README.md>)
- [D1.2 Multi-agent coordinator-subagent orchestration](<D1.2 - Multi-Agent Coordinator-Subagent Orchestration/README.md>)
- [D1.3 Subagent invocation, context passing and spawning](<D1.3 - Subagent Invocation Context Passing and Spawning/README.md>)
- [D1.4 Multi-step workflows with enforcement and handoff](<D1.4 - Multi-Step Workflows with Enforcement and Handoff/README.md>)
- [D1.5 Agent SDK hooks for interception and normalization](<D1.5 - Agent SDK Hooks for Interception and Normalization/README.md>)
- [D1.6 Task decomposition strategies](<D1.6 - Task Decomposition Strategies for Complex Workflows/README.md>)
- [D1.7 Session state, resumption and forking](<D1.7 - Session State Resumption and Forking/README.md>)

### Domain 2: Tool Design & MCP Integration
- [D2.1 Tool interfaces with clear descriptions and boundaries](<D2.1 - Tool Interface Design with Clear Descriptions/README.md>)
- [D2.2 Structured error responses for MCP tools](<D2.2 - Structured Error Responses for MCP Tools/README.md>)
- [D2.3 Tool distribution and tool_choice](<D2.3 - Tool Distribution and tool_choice Configuration/README.md>)
- [D2.4 MCP servers in Claude Code and agent workflows](<D2.4 - MCP Server Integration with Claude Code and Agents/README.md>)
- [D2.5 Built-in tools: Read, Write, Edit, Bash, Grep, Glob](<D2.5 - Built-in Tools Selection Read Write Edit Bash Grep Glob/README.md>)

### Domain 3: Claude Code Configuration & Workflows
- [D3.1 CLAUDE.md hierarchy, scoping and modular organization](<D3.1 - CLAUDE.md Hierarchy Scoping and Modular Organization/README.md>)
- [D3.2 Custom slash commands and skills](<D3.2 - Custom Slash Commands and Skills/README.md>)
- [D3.3 Path-specific rules for conditional convention loading](<D3.3 - Path-Specific Rules for Conditional Convention Loading/README.md>)
- [D3.4 Plan mode vs direct execution](<D3.4 - Plan Mode vs Direct Execution/README.md>)
- [D3.5 Iterative refinement techniques](<D3.5 - Iterative Refinement Techniques/README.md>)
- [D3.6 Claude Code in CI/CD pipelines](<D3.6 - Claude Code in CI-CD Pipelines/README.md>)

### Domain 4: Prompt Engineering & Structured Output
- [D4.1 Explicit criteria to reduce false positives](<D4.1 - Explicit Criteria to Reduce False Positives/README.md>)
- [D4.2 Few-shot prompting for consistency and quality](<D4.2 - Few-Shot Prompting for Consistency and Quality/README.md>)
- [D4.3 Structured output with tool use and JSON schemas](<D4.3 - Structured Output with Tool Use and JSON Schemas/README.md>)
- [D4.4 Validation, retry and feedback loops](<D4.4 - Validation Retry and Feedback Loops/README.md>)
- [D4.5 Efficient batch processing strategies](<D4.5 - Efficient Batch Processing Strategies/README.md>)
- [D4.6 Multi-instance and multi-pass review architectures](<D4.6 - Multi-Instance and Multi-Pass Review Architectures/README.md>)

### Domain 5: Context Management & Reliability
- [D5.1 Preserving critical context across long interactions](<D5.1 - Preserving Critical Context in Long Interactions/README.md>)
- [D5.2 Escalation and ambiguity resolution](<D5.2 - Escalation and Ambiguity Resolution Patterns/README.md>)
- [D5.3 Error propagation across multi-agent systems](<D5.3 - Error Propagation Across Multi-Agent Systems/README.md>)
- [D5.4 Context management in large codebase exploration](<D5.4 - Context Management in Large Codebase Exploration/README.md>)
- [D5.5 Human review workflows and confidence calibration](<D5.5 - Human Review Workflows and Confidence Calibration/README.md>)
- [D5.6 Information provenance in multi-source synthesis](<D5.6 - Information Provenance in Multi-Source Synthesis/README.md>)

## Setup

```bash
# Python 3.10+
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt

# Node.js 18+ (TypeScript labs run with tsx; no build step)
npm install
```

## Running a lab: offline vs live

Every lab runs **offline by default**. A scripted client in `shared/python/labkit.py` and
`shared/typescript/labkit.ts` replays deterministic model turns, so you can watch the
*architecture pattern* (loop control, hooks, error routing, validation) with no API key and no cost.
Each demo ends with `[PASS]` checks that prove the pattern behaved as described.

Add `--live` (or set `LAB_LIVE=1`) to call the real Claude API instead:

```bash
python "D1.1 - Agentic Loops for Autonomous Task Execution/python/agentic_loop.py"           # offline
python "D1.1 - Agentic Loops for Autonomous Task Execution/python/agentic_loop.py" --live    # real API
npx tsx "D1.1 - Agentic Loops for Autonomous Task Execution/typescript/agenticLoop.ts" --live
```

Live mode uses the standard SDK credential chain (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
`ant auth login` profile). Agent SDK labs also need the Claude Code runtime that the
`claude-agent-sdk` / `@anthropic-ai/claude-agent-sdk` packages drive.

Run every lab offline as a regression check:

```bash
python scripts/run_all_offline.py          # all Python labs   (filter: python scripts/run_all_offline.py D2.)
npm run labs:offline                       # all TypeScript labs
npm run typecheck                          # tsc --noEmit over every lab
```

## Things that changed since the exam guide was written

The exam guide is the source of truth for **concepts**. The SDKs have moved on in a few places,
and the labs use the current APIs. Each affected lab calls this out:

| Exam guide says | Current reality | Where it matters |
|---|---|---|
| Coordinators need `"Task"` in `allowedTools` to spawn subagents | The tool was renamed **`Agent`** (Claude Code v2.1.63). `Task` still works as an alias. Labs list `"Agent"` and detect both names. | D1.2, D1.3 |
| `tool_choice: "any"` and forced `{"type": "tool", "name": ...}` | Still exam-relevant, but **`claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1` return HTTP 400** for them. Labs that demo forced selection use `LAB_FORCED_TOOL_MODEL` (default `claude-opus-5`) and also show the modern alternative: `auto` + `strict: true` + verify, or `output_config.format` structured outputs. | D2.3, D4.3 |
| MCP Python `FastMCP` | `mcp` 2.x renamed it **`MCPServer`** (`from mcp.server import MCPServer`). | D2.2, D2.4 |
| Skill / command arguments `$1`… | Positional placeholders are **0-based** (`$0` is the first argument). `$ARGUMENTS` holds them all. | D3.2 |

## Repo layout

```
shared/python/labkit.py         offline/live switch, scripted client, response builders, PASS/FAIL checks
shared/typescript/labkit.ts     the same helpers for TypeScript
scripts/                        run-all-offline runners
D<x>.<y> - <title>/
    README.md                   exam objectives -> code map, how to run, exam traps, exercises
    python/                     Python implementation
    typescript/                 TypeScript implementation
    (config/, example-repo/ ...) Claude Code config samples where the concept is configuration
```

Default model for live runs: `claude-opus-5-5`. Override it with `LAB_MODEL`.
