# Logging

- Structured JSON logs through `packages/shared/src/logger.ts`; no `console.log` in committed code.
- Include `requestId` and `orderId` when available. Never include card numbers, CVV, passwords, tokens
  or full email addresses.
- `logger.warn` for handled-but-unexpected conditions; `logger.error` only for failures someone must act on.
