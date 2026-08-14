# Security

## Reporting a vulnerability

Report a suspected vulnerability privately to the repository owner before opening a public issue.

Do not include private source code or filesystem paths unless they are necessary to explain the issue. Include what you can: affected version, what an attacker would need to control, and the steps that reproduce it.

## Supported versions

Only the latest published release of ChangeLens receives fixes.

## Scope

- Baselines are stored in the extension's own storage directory, provided by VS Code. No ChangeLens metadata is written to your workspace or repository. Workspace files change only when you explicitly use a Revert action.
- Baseline content is gzipped and filed under a hash of its own bytes. It is not encrypted; anyone who can read your user profile can read it.
- The extension makes no network requests and bundles no runtime dependencies. The prepublish check runs `scripts/audit-bundle.mjs`, which rejects a bundle containing a URL, a runtime dependency, `eval`, or a shell invocation.
- The only external program it runs is `git rev-parse --git-path HEAD`, executed without a shell, to locate the HEAD that governs each workspace folder.
- ChangeLens is disabled in Restricted Mode and virtual workspaces. Revert actions can modify, delete, or recreate workspace files, while branch tracking may run the fixed Git command described above.
