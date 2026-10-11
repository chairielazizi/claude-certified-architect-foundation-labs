# packages/payments

Payment service: charges, refunds and payouts. Maintained by the payments team.

This package handles cardholder data, so the PCI DSS rules apply to every change here:
@../../docs/standards/pci-dss.md

## Package specifics

- All gateway calls go through `src/gateway/client.ts`; it owns retries and idempotency keys.
- Amounts are `amountMinor` integers. Convert at the API boundary with `toMinorUnits()` from `src/money.ts`.
- While iterating, run only this package's tests (the `test` script in this package's `package.json`).
