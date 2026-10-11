# acme-shop monorepo

Everything the team knows, in one file. It has grown to the point where nobody owns any part of it and
every change conflicts with someone else's. (This is the "before" picture for split_claude_md.)

## Repository layout

- `packages/payments/` - payment service (Node 22, Fastify).
- `packages/web/` - storefront SPA (React 19, Vite).
- `packages/shared/` - types and utilities used by both. No runtime dependencies allowed here.

## Code standards (all packages)

- Small pure functions; keep side effects at the edges (route handlers, components, CLI entry points).
- No `any`. Use `unknown` plus a type guard at trust boundaries.
- Money is an integer number of minor units (`amountMinor`) plus an ISO 4217 `currency`. Never floats.

## Testing

- Unit tests live next to the code they test: `refunds.ts` -> `refunds.test.ts`.
- Use the `node:test` runner (`describe` / `it`) with `node:assert/strict`. No Jest or Vitest globals.
- Test behavior through a module's public API, not its private helpers.
- Name tests as sentences: `it("rejects a refund larger than the original charge")`.
- One behavior per test. Use table-driven cases for input/output variations.
- No network and no real clock in unit tests: inject `fetch` and `now()` and use the fakes in
  `packages/shared/src/testing/`.
- A bug fix starts with a failing test that reproduces the bug.

## API conventions

- REST over HTTPS with JSON bodies and `camelCase` field names.
- Routes are plural nouns: `GET /orders/:orderId`, `POST /orders/:orderId/refunds`.
- Validate every request body with the zod schema that sits next to the handler; on failure return 400
  with the error envelope.
- Error envelope: `{ "error": { "code": "REFUND_EXCEEDS_CHARGE", "message": "...", "retryable": false } }`.
- `POST` endpoints that move money require an `Idempotency-Key` header; a replay returns the original
  response instead of charging twice.
- Never break a published response shape: add fields, do not rename or remove them. Breaking changes
  need a new version prefix (`/v2/...`).

## Deployment

- Every merge to `main` deploys to staging automatically. Production deploys are manual, from a tagged
  release.
- Database migrations must stay compatible with the previous release (expand, migrate, then contract in
  a later release).
- Gate user-visible changes that are not ready for everyone behind a flag in `packages/shared/src/flags.ts`.
- Do not edit `infra/` or `.github/workflows/` unless explicitly asked; those changes need platform-team
  review.
- Configuration comes from environment variables validated at startup. Never hard-code hostnames,
  credentials or API keys.
