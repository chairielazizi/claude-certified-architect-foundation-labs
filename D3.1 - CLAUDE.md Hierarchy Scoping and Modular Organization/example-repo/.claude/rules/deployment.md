# Deployment

- Every merge to `main` deploys to staging automatically. Production deploys are manual, from a tagged
  release.
- Database migrations must stay compatible with the previous release (expand, migrate, then contract in
  a later release).
- Gate user-visible changes that are not ready for everyone behind a flag in `packages/shared/src/flags.ts`.
- Do not edit `infra/` or `.github/workflows/` unless explicitly asked; those changes need platform-team
  review.
- Configuration comes from environment variables validated at startup. Never hard-code hostnames,
  credentials or API keys.
