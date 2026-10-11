---
name: review-strict
description: My stricter personal review - the team /review checklist plus naming, missing docs and long functions. Only for when I explicitly ask for a strict review.
argument-hint: "[optional focus area]"
disable-model-invocation: true
allowed-tools: Read Grep Glob Bash(git diff *)
---
First apply the team checklist exactly as written in `.claude/commands/review.md` (read it; do not
rely on memory, it changes). Extra focus: $ARGUMENTS

Then apply my additional rules and label those findings `[strict]`, so I can tell them apart from
team-standard findings when I paste the review into a pull request:
- Any function longer than 40 lines.
- Exported functions or components without a doc comment.
- Names that need a comment to be understood (`data`, `info`, `handle2`, single letters outside loops).
- Boolean parameters that should be an options object.
