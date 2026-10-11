# payments-api

Project context for everyone who runs Claude Code here: developers, and the CI jobs in
`.github/workflows/` (they run `claude -p` from the repo root, so this file loads automatically).

## Stack

- Python 3.12, `src/` layout (`src/payments/`), pytest. Run tests with `pytest -q`.
- Money is integer cents everywhere. Parse decimal strings with `decimal.Decimal`, never `float`.

## Review criteria (used by the PR review job)

Report a finding only if it is one of these, with the line in the NEW version of the file:

- **security**: SQL built with string formatting or f-strings (use `?` parameters); card numbers,
  CVV, tokens or emails written to logs (log `card_last4` only); missing authorization checks.
- **correctness**: float money; refunds whose running total can exceed the original charge;
  idempotency keys accepted but not forwarded to the gateway; swallowed exceptions.
- **test-coverage**: a behavior change with no test that would fail without it.
- **maintainability**: only when it hides a bug (dead branches, misleading names). No style nits:
  formatting and import order are enforced by ruff in a separate job.

Severity: `critical` = money or card data at risk; `high` = wrong result for real inputs;
`medium` = edge case or missing test; `low` = everything else (rarely worth a comment).

## Testing standards (used by the test-generation job)

- Test behavior through `refund_charge`, not private helpers. One behavior per test; the docstring
  states the behavior as a sentence.
- A valuable test fails for a plausible bug: boundaries (exact limits, cumulative partial refunds),
  error codes, money precision (`"1204.35"` must be 120435 cents), idempotency, what is logged.
- Not valuable: asserting dataclass fields exist, re-testing the standard library, mocking the
  function under test, snapshot-style asserts on whole objects.
- Read `tests/` first and do not propose scenarios that are already covered.

## Available fixtures (`tests/conftest.py`)

- `db` - in-memory SQLite with the real `charges` and `refunds` schema.
- `charge_factory(amount_cents=5000, status="settled", card_number=...)` - inserts a charge, returns its id.
- `fake_gateway` - records `refund()` calls in `.calls` and replays responses for a repeated idempotency key.
- pytest built-ins such as `caplog` (assert on log output) and `monkeypatch`.

Do not invent other fixtures or mock the database; use these.
