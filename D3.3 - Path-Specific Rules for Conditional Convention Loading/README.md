# D3.3: Apply path-specific rules for conditional convention loading

**Domain 3: Claude Code Configuration & Workflows (20%)** · Task Statement 3.3
**Exam scenarios:** Code Generation with Claude Code, Developer Productivity with Claude

## What the exam expects

| Knowledge | Skill |
|---|---|
| `.claude/rules/` files with YAML frontmatter `paths:` globs activate conditionally | Write rule files with path scoping, such as `paths: ["terraform/**/*"]`, so they load only when Claude edits matching files |
| Path-scoped rules load only when matching files are edited, so irrelevant context and tokens are cut | Use globs to apply conventions by file type wherever the file lives, for example `**/*.test.tsx` for every test |
| Glob rules beat directory-level CLAUDE.md for conventions that span directories, such as tests spread through the codebase | Choose path-specific rules over subdirectory CLAUDE.md files when the files are scattered |

## The pattern

```
.claude/rules/
  general.md            (no paths)                         -> every session
  terraform.md          paths: ["terraform/**/*"]          -> only when touching terraform/...
  tests.md              paths:                             -> any test file, ANY directory
                          - "**/*.test.tsx"
                          - "**/*.test.ts"
  api.md                paths: ["src/api/**/*"]
  react-components.md   paths: ["src/components/**/*.tsx"]

Claude reads/edits src/components/forms/TextField.test.tsx
  -> general.md + tests.md (**/*.test.tsx) + react-components.md (src/components/**/*.tsx)
```

## Files

| File | What it shows |
|---|---|
| `example-repo/.claude/rules/*.md` | Five realistic rule files: one unconditional, four path-scoped. They use both `paths: [...]` flow style and a YAML block list |
| `example-repo/src/**`, `e2e/`, `terraform/**` | Sample files spread across directories. Test files sit next to the code they test, in five different directories |
| `python/glob_match.py`, `typescript/globMatch.ts` | A dependency-free matcher for `**`, `*`, `?`, `{a,b}` (nested) and `[!x]`, plus a 17-case self-test |
| `python/rule_loader.py`, `typescript/ruleLoader.ts` | Parses frontmatter (YAML list or comma string), then answers "which rules load for these touched files, and which glob matched" for seven editing sessions. Also catches the unquoted-`*` YAML trap |
| `python/compare_approaches.py`, `typescript/compareApproaches.ts` | Monolithic CLAUDE.md vs path rules vs directory CLAUDE.md: tokens per session, how many copies the directory approach needs, irrelevant loads, and a new test directory that gets missed |

## Run it

```bash
python "D3.3 - Path-Specific Rules for Conditional Convention Loading/python/rule_loader.py"
python "D3.3 - Path-Specific Rules for Conditional Convention Loading/python/compare_approaches.py"
npx tsx "D3.3 - Path-Specific Rules for Conditional Convention Loading/typescript/ruleLoader.ts"
npx tsx "D3.3 - Path-Specific Rules for Conditional Convention Loading/typescript/compareApproaches.ts"

# the real thing: open the sample repo, ask Claude to edit a test, then run /memory or /context
cd "D3.3 - Path-Specific Rules for Conditional Convention Loading/example-repo" && claude
```

No model is called. The scripts simulate Claude Code's rule activation. Expected output (abridged):

```
  edit a component test: src/components/Button.test.tsx
    + general.md             always (no paths:)
    + react-components.md    'src/components/**/*.tsx' matched src/components/Button.test.tsx
    + tests.md               '**/*.test.tsx' matched src/components/Button.test.tsx

  session                    A monolith  B rules  C dirs   test rules loaded? (B / C)
  edit a component                  ...      ...     ...   no / yes  (not a test file)
  average                           805      329   -> path rules save 59% vs the monolith
  [PASS] directory CLAUDE.md needs the test conventions copied into 4 places; tests.md is ONE file
  [PASS] a new src/hooks/useCart.test.ts: **/*.test.ts covers it automatically; no directory CLAUDE.md exists there
```

## Why glob rules beat directory CLAUDE.md for cross-cutting conventions

| | Path-scoped rule (`**/*.test.ts`) | Directory CLAUDE.md |
|---|---|---|
| Where the convention lives | One file | A copy in every directory tree that has tests (4 here) |
| Changing a convention | Edit one file | Edit every copy, and hope none drift |
| Editing a non-test file next to tests (`Button.tsx`) | Test rules stay out | Test rules load anyway, because the whole directory gets them |
| Adding a test in a new directory (`src/hooks/`) | Covered automatically | Missed until someone adds another CLAUDE.md |
| Good fit for | Conventions keyed to **file type** | Conventions keyed to **one subtree** (a package's own notes) |

## Exam traps

- **Sample question 6.** The codebase has React components, API handlers and DB models, each with its own conventions, plus test files next to the code everywhere. The most maintainable way to apply the right conventions automatically is (A) `.claude/rules/` files with glob `paths:`. (B), one root CLAUDE.md with a section per area, relies on Claude inferring which section applies and loads everything every time. (C), skills, need someone to invoke them or Claude to choose to, which is not deterministic "automatic" application. (D), one CLAUDE.md per subdirectory, is directory-bound and can't follow test files spread across directories.
- **No `paths:` means always loaded.** A rule without frontmatter costs tokens in every session, just like CLAUDE.md. The token savings come from `paths:`.
- **Rules stack.** A file can match several rules. `Button.test.tsx` gets both the test conventions and the React component conventions. Write rules so they compose instead of contradicting each other.
- **`**/` matches zero directories.** `terraform/**/*` covers `terraform/main.tf` and `terraform/modules/network/main.tf`. `src/components/*.tsx` does not reach into `src/components/forms/`.
- **Quote your globs.** In YAML, a value that starts with `*` is an alias, so `paths: **/*.test.ts` is a parse error. Write `"**/*.test.ts"`. The loader turns that into a clear error with a fix.
- **Triggering is about files Claude touches.** A path-scoped rule loads when Claude reads or edits a matching file, not when you merely mention a path in the prompt.

## Try this next

1. Add `src/db/` with a repository-pattern model and a `rules/db-models.md` (`paths: ["src/db/**/*.ts"]`). Rerun both scripts and watch the monolith grow while path-rule sessions stay flat.
2. Change `react-components.md` to `paths: ["src/components/**/*.tsx", "!**/*.test.tsx"]`. The matcher treats `!` literally. Decide whether you'd rather split the rule than rely on negation.
3. Extend `glob_match` with a `dot` option that stops `*` from matching names starting with `.`, then add self-test cases for `.github/workflows/*.yml`.
