# acme-shop monorepo

Team-wide instructions for Claude Code. This file is committed, so every developer and every CI job
gets it. Personal preferences belong in `~/.claude/CLAUDE.md` (all your projects) or in
`CLAUDE.local.md` (this repo only, gitignored). Owner: platform team (#platform-eng, platform@acme.example).

## Repository layout

- `packages/payments/` - payment service (Node 22, Fastify). Its own CLAUDE.md adds the PCI DSS rules.
- `packages/web/` - storefront SPA (React 19, Vite). Its own CLAUDE.md adds the React conventions.
- `packages/shared/` - types and utilities used by both. No runtime dependencies allowed here.
- `docs/standards/` - source of truth for team standards. Package CLAUDE.md files import only the
  standards they need (for example payments imports `@../../docs/standards/pci-dss.md`).

Topic rules (testing, API conventions, deployment) live in `.claude/rules/`, one file per topic.

## Tooling

- Node 22 LTS (pinned in `.nvmrc`). TypeScript strict mode everywhere; never loosen `tsconfig` flags to
  make an error go away.
- Scripts are defined in the root `package.json`: `build`, `typecheck`, `test`, `lint`.

## Code standards (all packages)

- Small pure functions; keep side effects at the edges (route handlers, components, CLI entry points).
- No `any`. Use `unknown` plus a type guard at trust boundaries.
- Money is an integer number of minor units (`amountMinor`) plus an ISO 4217 `currency`. Never floats.
- Throw the typed errors from `packages/shared/src/errors.ts`; never throw strings.

## Git workflow

@docs/standards/git-workflow.md

## Before you say "done"

- Typecheck and tests pass for every package you touched.
- New behavior has a test; a bug fix starts with a failing test that reproduces the bug.
