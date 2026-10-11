# acme-shop storefront

Conventions are split by file type in `.claude/rules/`. `general.md` always loads; the others declare
`paths:` globs and load only when Claude reads or edits a matching file:

- `terraform.md` - `terraform/**/*`
- `tests.md` - `**/*.test.tsx`, `**/*.test.ts` (test files live next to the code they test, everywhere)
- `api.md` - `src/api/**/*`
- `react-components.md` - `src/components/**/*.tsx`

When you add a convention, put it in the rule whose globs match the files it governs. Do not add
directory-level CLAUDE.md files for conventions that span directories.
