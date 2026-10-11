---
name: brainstorm-alternatives
description: Explore several genuinely different designs for a problem and compare their trade-offs without changing any code. Use when asked for options, alternatives or a design comparison.
argument-hint: "[problem statement]"
context: fork
allowed-tools: Read Grep Glob
---
Problem: $ARGUMENTS

1. Read enough of the relevant code to understand the constraints (cite the files you used).
2. Propose 3-4 genuinely different approaches, not variations of one idea. For each one give:
   how it works (3-5 bullets), what it would change in this codebase, cost and risk, and when it is
   the right choice.
3. Recommend one, and name the single trade-off that decided it.

Do not edit files. The brainstorming itself (dead ends, half-ideas) stays in this forked context; return
only a comparison table of the approaches and your recommendation.
