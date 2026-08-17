# Security

## Reporting a vulnerability

Report a suspected vulnerability privately to the repository owner before opening a public issue.

Do not include private source code or filesystem paths unless they are necessary to explain the issue. Include what you can: affected version, what an attacker would need to control, and the steps that reproduce it.

## Supported versions

Only the latest published release of ChangeLens receives fixes.

## Scope

- Baselines are stored in the extension's own storage directory, provided by VS Code. No ChangeLens metadata is written to your workspace or repository. Workspace files change only when you explicitly use a Revert action.
- Baseline content is gzipped and filed under a hash of its own bytes. It is not encrypted; anyone who can read your user profile can read it.
- The extension makes no network requests and bundles no runtime dependencies. The prepublish check runs `scripts/audit-bundle.mjs`, which rejects a bundle containing a URL, a runtime dependency, `eval`, a shell invocation, or a second process call site.
- The only external program it runs is `git`, executed without a shell and only to read: `rev-parse` to locate the HEAD, reflog, and root that govern a workspace folder, `symbolic-ref` for the branch HEAD points at, `status` for which files differ from HEAD, and `diff --name-only` for which files a Git operation rewrote. No workspace path is ever passed as an argument, and the commit arguments to `diff` are taken from the reflog only after matching a hexadecimal object name.
- ChangeLens is disabled in Restricted Mode and virtual workspaces. Revert actions can modify, delete, or recreate workspace files, while Git tracking may run the read-only commands described above.
