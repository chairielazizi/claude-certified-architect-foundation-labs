# General conventions (no `paths:`, so this loads in every session)

- TypeScript strict mode; no `any`. Use `unknown` and narrow it.
- Money is integer minor units (`amountMinor`) plus a `currency`; format only at the edge with `formatMoney()`.
- Small pure functions; keep I/O (network, database, clock) at the edges and inject it.
- Commit messages follow Conventional Commits (`feat(api): ...`, `fix(infra): ...`).
