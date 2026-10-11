---
name: codebase-analysis
description: Deep-dive analysis of a module or directory - entry points, data flow, dependencies, callers and risky areas. Use when asked how part of the codebase works, or before planning a large change to it.
argument-hint: "[path or module] [optional question]"
context: fork
agent: Explore
allowed-tools: Read Grep Glob
---
Analyze this part of the codebase: $ARGUMENTS

Work in this order and keep track of every file you open:
1. Find entry points with Grep first (exported functions, route registrations, CLI commands). Do not read
   whole directories up front.
2. Follow imports from those entry points with Read and trace the main data flow end to end.
3. Find who calls this code: Grep for each exported name across the repository.
4. List external dependencies: packages, services, environment variables.
5. Flag risks: untested paths, broad catch blocks, TODO/FIXME comments, functions longer than ~80 lines.

Return ONLY the summary below. Your exploration notes stay in this forked context and never reach the
main conversation, so make the summary self-contained.

- Purpose (two sentences)
- Entry points (`path:line`)
- Data flow (numbered steps)
- Callers and dependencies
- Risks, most important first
- Files read: how many, plus the five most relevant paths
