# Changelog

Notable changes to ChangeLens. Release Please builds this file from the [commit subjects](.github/commit-instructions.md) that land on `main`, and the versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1](https://github.com/ragentis/changelens-vscode/compare/v0.2.0...v0.2.1) (2026-08-20)


### Fixed

* **model:** derive reconciled files behind the event work queued for them ([4e7fbd5](https://github.com/ragentis/changelens-vscode/commit/4e7fbd5ab693953b32a0c902072640bb2e2bf765))
* **model:** keep telling typing apart from a reload after a baseline reset ([6c002cd](https://github.com/ragentis/changelens-vscode/commit/6c002cd1f8eb6f0817c9bedc99d88029b19a75d7))
* **model:** never fold a reloaded buffer into the baseline as an edit ([82ce59c](https://github.com/ragentis/changelens-vscode/commit/82ce59c677eef45475236692f90c9353ae3a962c))
* **model:** report a deletion while a clean editor still shows the file ([bd3c1c5](https://github.com/ragentis/changelens-vscode/commit/bd3c1c5eb87e746b7ab9c4fe81dc256a0fe3eab3))
* **model:** settle folders and forget content when replaying parked events ([ec13867](https://github.com/ragentis/changelens-vscode/commit/ec1386795acea9822260546612558800e637c2db))
* **storage:** leave a freshly created blob bucket alone when sweeping ([80f0e62](https://github.com/ragentis/changelens-vscode/commit/80f0e628c78cb0d1204621089ea8580e2f37548a))
* **tracking:** review what a closed buffer leaves behind on disk ([6b8690d](https://github.com/ragentis/changelens-vscode/commit/6b8690da364cf08bfadba9edd6ddd5f6405125d3))

## [0.2.0](https://github.com/ragentis/changelens-vscode/compare/v0.1.0...v0.2.0) (2026-08-17)


### Added

* **tracking:** attribute Git's own writes instead of reviewing them ([476a24f](https://github.com/ragentis/changelens-vscode/commit/476a24f6c48018b8ba5fd3166889936536969308))
* **ui:** show the line count and content behind a deletion marker ([6a7fd91](https://github.com/ragentis/changelens-vscode/commit/6a7fd9103e875e10d86d1ec7047cd18d8cc0e523))


### Fixed

* **commands:** keep Open File working on a review tab after its changes are accepted ([cae660b](https://github.com/ragentis/changelens-vscode/commit/cae660b4d3ac48a8412f9fda2642dc45b5ae53b7))

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
