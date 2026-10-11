---
description: Review the current branch against the team's code review checklist
argument-hint: "[optional focus, e.g. security or performance]"
allowed-tools: Read Grep Glob Bash(git diff *) Bash(git log *)
---
Review the changes on this branch against the team checklist below.

## What changed
!`git diff --stat main...HEAD`

Read the full diff with `git diff main...HEAD` and open any file you need for context.

## Extra focus requested by the developer
$ARGUMENTS

## Checklist
1. Correctness: edge cases (empty input, nulls, boundaries), error paths, off-by-one errors.
2. Security: input validated at trust boundaries, authorization on every new route, no secrets in code or logs.
3. Tests: every behavior change has a test; every bug fix has a regression test that failed before the fix.
4. API compatibility: no renamed or removed response fields; breaking changes go behind a new version.
5. Readability: clear names, small functions, comments that explain why rather than what.

## Output format
For each finding: `path:line`, severity (blocker / should-fix / nit), what is wrong, and a concrete fix.
Report only real problems. Do not pad the list, and do not repeat style issues the linter already catches.
Finish with one line: APPROVE, APPROVE WITH NITS, or REQUEST CHANGES.
