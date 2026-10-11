# Git workflow

- Branch from `main`: `feat/<ticket>-short-name` or `fix/<ticket>-short-name`.
- Conventional Commits with the package as scope: `feat(payments): support partial refunds`.
- Keep pull requests under ~400 changed lines. Split refactors from behavior changes.
- Never commit secrets, `.env` files or generated build output.
- Rebase on `main` before requesting review; do not merge `main` into feature branches.
