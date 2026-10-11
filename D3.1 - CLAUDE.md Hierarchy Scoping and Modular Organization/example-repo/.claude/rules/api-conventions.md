# API conventions

- REST over HTTPS with JSON bodies and `camelCase` field names.
- Routes are plural nouns: `GET /orders/:orderId`, `POST /orders/:orderId/refunds`.
- Validate every request body with the zod schema that sits next to the handler; on failure return 400
  with the error envelope.
- Error envelope: `{ "error": { "code": "REFUND_EXCEEDS_CHARGE", "message": "...", "retryable": false } }`.
- `POST` endpoints that move money require an `Idempotency-Key` header; a replay returns the original
  response instead of charging twice.
- Never break a published response shape: add fields, do not rename or remove them. Breaking changes
  need a new version prefix (`/v2/...`).
