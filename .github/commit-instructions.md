# Commit message instructions

Use Conventional Commits for every commit.

```text
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## Types

The type decides the next version and the changelog section. Use no type outside this table.

| Type       | Use for                                   | Version | Changelog section |
| ---------- | ----------------------------------------- | ------- | ----------------- |
| `feat`     | New user-visible behavior or settings     | minor   | Added             |
| `fix`      | Bug fixes, including security fixes       | patch   | Fixed             |
| `perf`     | Performance improvements                  | patch   | Performance       |
| `revert`   | Undoing a change that already shipped     | patch   | Reverted          |
| `refactor` | Internal changes without behavior changes | —       | —                 |
| `test`     | Test additions or corrections             | —       | —                 |
| `docs`     | Documentation-only changes                | —       | —                 |
| `style`    | Formatting-only changes                   | —       | —                 |
| `build`    | Bundling, packaging, or build tooling     | —       | —                 |
| `ci`       | GitHub Actions and other CI changes       | —       | —                 |
| `chore`    | Repository maintenance not covered above  | —       | —                 |

## Scopes

The scope is optional. Prefer one of these when it makes the affected area clearer:

- `core` — diff, rebase, text, and unified-view algorithms
- `model` — canonical change state and accept/revert behavior
- `tracking` — workspace filtering, ignore rules, and file watchers
- `storage` — baseline persistence, blobs, and garbage collection
- `commands` — command registration and command behavior
- `ui` — tree views, decorations, CodeLens, status bar, and review documents
- `config` — extension manifest, TypeScript, formatter, linter, and editor configuration
- `build` — bundling, packaging, and cleanup scripts
- `audit` — the bundle security checks
- `deps` — dependency and lockfile updates
- `ci` — workflows and automated verification
- `docs` — user or contributor documentation, when the scope adds useful context
- `repo` — repository-wide maintenance

Use a more specific module or feature name when it is clearer than this list. Do not force a scope onto a repository-wide or obvious documentation change.

## Rules

- Write the description in imperative mood, lowercase after the colon, without a trailing period.
- Keep the first line concise, preferably at or below 72 characters.
- Describe one coherent change per commit; use the body to explain motivation or non-obvious tradeoffs.
- Put issue references and other metadata in footers.
- Visual or user-facing display changes are `feat` or `fix`, never `style`.
- Mark a breaking change with `!` after the type or scope and add a `BREAKING CHANGE:` footer explaining the migration impact. Treat renamed or removed settings, commands, and other extension contracts as breaking changes.

## Examples

```text
feat(tracking): detect external workspace writes
fix(model): preserve pending hunks during editor changes
refactor(storage): validate baseline index before loading
test(core): cover deletion-only unified views
build(audit): pin bundle inputs and runtime modules
ci: run verification on Windows
docs: document baseline reset behavior
feat(config)!: rename the review mode setting

BREAKING CHANGE: Replace changelens.reviewMode with
changelens.diffMode in user settings.
```
