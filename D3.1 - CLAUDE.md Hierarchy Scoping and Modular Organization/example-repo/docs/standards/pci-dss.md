# PCI DSS rules for code that touches card data

Applies to every change in `packages/payments/`.

- Never store, log or return a full card number (PAN). Only the last four digits and the vault token may
  leave the vault client.
- Never store the card security code (CVV/CVC) in any form, not even temporarily, not even encrypted.
- Card data goes to the vault (`vaultClient.tokenize`) before any other processing.
- Every read of cardholder data is audit-logged through `auditLog.record()`.

Logging rules that apply on top of the above: @logging.md
