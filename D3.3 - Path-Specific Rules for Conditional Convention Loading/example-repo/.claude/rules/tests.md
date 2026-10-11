---
paths:
  - "**/*.test.tsx"
  - "**/*.test.ts"
---
# Test conventions (every test file, wherever it lives)

- Use `node:test` (`describe` / `it`) with `node:assert/strict`. No Jest or Vitest globals.
- Name tests as behavior sentences: `it("returns 404 ORDER_NOT_FOUND for an unknown order")`.
- Arrange, act, assert. One behavior per test; table-driven cases for input variations.
- Components: render with `@testing-library/react` and query by role and accessible name (`getByRole`).
  No snapshot tests. Query by test id only when nothing accessible exists.
- No real network, clock or randomness: inject fakes (`repo`, `now`, `fetch`).
- Async failures: `await assert.rejects(promise, predicate)`. Never a try/catch that can pass silently.
- End-to-end tests in `e2e/` skip themselves unless `E2E_BASE_URL` is set.
