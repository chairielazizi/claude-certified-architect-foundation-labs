# packages/web

Storefront SPA (React 19, Vite, TanStack Query). Maintained by the web team.

@../../docs/standards/react.md

## Package specifics

- Routes live in `src/routes/`; each route file exports a `loader` and a default component.
- Talk to the backend only through the generated client in `src/api/client.ts`; never call `fetch` directly.
- User-facing copy comes from `src/i18n/en.json`; no hard-coded strings in components.
