---
paths: ["src/api/**/*"]
---
# API handler conventions

- Handlers are `async` functions that receive their dependencies (repositories, clients) as parameters.
- Validate input first; throw `ApiError(400, "INVALID_...")` for malformed input.
- Map every failure to an `ApiError` with a stable `code`: 404 `*_NOT_FOUND`, 409 for conflicts, 503
  `*_UNAVAILABLE` with `retryable: true` for dependency outages. Never let a raw driver error escape.
- `await` every promise inside a `try` that maps errors; no floating promises, no `.then()` chains.
- Return plain JSON-serializable objects with `camelCase` fields; amounts as `...Minor` integers plus `currency`.
- No `console.log`; use the injected logger.
