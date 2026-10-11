# acme-shop storefront

Always-on team standards live here. Task-specific workflows are on-demand commands and skills in
`.claude/`, so their instructions only enter context when someone runs them.

## Standards (apply to every task)

- TypeScript strict mode; no `any`.
- React: function components and hooks only; one component per file.
- Conventional Commits (`feat(cart): ...`).
- Use pnpm, never npm or yarn.

## Workflows (invoke on demand)

- `/review [focus]` - the team code review checklist (`.claude/commands/review.md`).
- `/codebase-analysis <path> [question]` - deep dive that runs in a forked Explore context.
- `/scaffold-component <Name> <directory>` - new component, test and CSS module.
- `/brainstorm-alternatives <problem>` - compare designs without editing code (forked context).
