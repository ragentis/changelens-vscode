# Changelog

Notable changes to ChangeLens. Release Please builds this file from the [commit subjects](.github/commit-instructions.md) that land on `main`, and the versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 (2026-08-15)

First release.

### Added

* Per-block review of changes made by AI agents and other external processes, against a baseline ChangeLens captures independently of Git.
* Accept and revert actions for individual blocks, whole files, or all pending changes, with configurable navigation to the next remaining block, confirmation before destructive operations, and protection against overwriting newer changes.
* Two review modes: Unified and VS Code's built-in diff editor. Unified is read-only, opens at the first change, keeps removed lines above their replacements in full file context, and retains syntax highlighting without misleading diagnostics for supported languages. The choice is remembered per workspace.
* Editor changes are folded into the baseline as you type, and editor file operations are adopted, so only changes from outside VS Code appear for review.
* A Changes view in the Activity Bar, available as a tree or flat list, with file decorations, editor highlighting, CodeLens actions, and a status bar count.
* File-level tracking for binary and oversized files, with the reason shown, normal VS Code file handling for files still present, and confirmed deletion when reverting a newly added file. Modified or deleted files remain non-revertible because their previous content is not stored.
* Scope control through each workspace folder's root `.gitignore` and the `changelens.exclude` setting.
* Git branch-change detection for regular repositories, worktrees, and submodules, with a prompt before resetting a baseline that has pending changes.
* Compressed, content-addressed baseline storage with atomic writes and automatic cleanup.
* No repository metadata, telemetry, runtime dependencies, or network requests.
