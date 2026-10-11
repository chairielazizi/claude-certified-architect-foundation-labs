---
description: Draft my stand-up update from my own recent commits
argument-hint: "[what I plan to do today]"
allowed-tools: Bash(git log *)
---
My commits since yesterday morning:
!`git log --since="yesterday 06:00" --author="$(git config user.email)" --oneline`

Draft my stand-up update as three short bullets: Yesterday (from the commits above, grouped by
feature, no commit hashes), Today ($ARGUMENTS), Blockers (write "none" unless a commit message
mentions one). Plain text, no headings.
