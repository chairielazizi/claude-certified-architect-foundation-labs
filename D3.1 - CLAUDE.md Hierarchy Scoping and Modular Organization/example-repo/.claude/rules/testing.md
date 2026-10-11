# Testing

- Unit tests live next to the code they test: `refunds.ts` -> `refunds.test.ts`.
- Use the `node:test` runner (`describe` / `it`) with `node:assert/strict`. No Jest or Vitest globals.
- Test behavior through a module's public API, not its private helpers.
- Name tests as sentences: `it("rejects a refund larger than the original charge")`.
- One behavior per test. Use table-driven cases for input/output variations.
- No network and no real clock in unit tests: inject `fetch` and `now()` and use the fakes in
  `packages/shared/src/testing/`.
- A bug fix starts with a failing test that reproduces the bug.
