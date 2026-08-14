import * as path from "node:path";
import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { resolveGitHead } from "./gitHead";

const DISK_DEBOUNCE_MS = 150;
const BUFFER_DEBOUNCE_MS = 400;
/** Repository changes trigger workspace-wide work, so use a longer debounce than file writes. */
const REPO_DEBOUNCE_MS = 500;

/** Settings that change which files are tracked, and so need more than a filter rebuild. */
const SCOPE_SETTINGS = [
  "changelens.exclude",
  "changelens.respectGitignore",
  "changelens.maxFileSizeKb",
];

export interface WorkspaceWatcherOptions {
  onError?: (message: string, error?: unknown) => void;
}

export class WorkspaceWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private repoWatchers: vscode.Disposable[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  /** Prevents stale asynchronous HEAD-path lookups from registering watchers. */
  private repoGeneration = 0;
  private readonly onError: (message: string, error?: unknown) => void;

  constructor(
    private readonly model: ChangeModel,
    private readonly onGitHeadChanged: () => Promise<void> | void,
    options: WorkspaceWatcherOptions = {},
  ) {
    this.onError = options.onError ?? (() => undefined);
  }

  // ── workspace events ─────────────────────────────────────────────────────

  activate(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) =>
        this.schedule(`disk:${uri.fsPath}`, DISK_DEBOUNCE_MS, "A file change", () =>
          this.model.handleDiskWrite(uri),
        ),
      ),
      watcher.onDidCreate((uri) =>
        this.schedule(`disk:${uri.fsPath}`, DISK_DEBOUNCE_MS, "A new file", () =>
          this.model.handleDiskWrite(uri),
        ),
      ),
      watcher.onDidDelete((uri) =>
        this.schedule(`disk:${uri.fsPath}`, DISK_DEBOUNCE_MS, "A file deletion", () =>
          this.model.handleDiskDelete(uri),
        ),
      ),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.schedule(
          `buffer:${event.document.uri.fsPath}`,
          BUFFER_DEBOUNCE_MS,
          "An editor change",
          () => this.model.handleBufferChange(event.document),
        ),
      ),
      vscode.workspace.onDidOpenTextDocument((doc) => this.model.handleDocumentOpened(doc)),
      vscode.workspace.onDidSaveTextDocument((doc) =>
        this.dispatch("A file save", () => this.model.handleSave(doc)),
      ),
      vscode.workspace.onDidCreateFiles((event) =>
        this.dispatch("A file creation", () => this.model.handleEditorCreate(event.files)),
      ),
      vscode.workspace.onDidDeleteFiles((event) =>
        this.dispatch("A file deletion", () => this.model.handleEditorDelete(event.files)),
      ),
      vscode.workspace.onDidRenameFiles((event) =>
        this.dispatch("A file rename", () => this.model.handleEditorRename(event.files)),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("changelens")) {
          return;
        }
        const rescoping = SCOPE_SETTINGS.some((setting) => event.affectsConfiguration(setting));
        this.dispatch("A settings change", async () => {
          if (rescoping) {
            await this.model.rescope();
            return;
          }
          await this.model.reloadConfig();
          this.model.fire();
        });
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        // Baseline newly opened roots before their existing files look newly created.
        this.dispatch("A workspace folder change", () => this.model.rescope());
        this.watchRepositories();
      }),
    );
    for (const doc of vscode.workspace.textDocuments) {
      this.model.handleDocumentOpened(doc);
    }
    this.watchRepositories();
  }

  // ── repository events ────────────────────────────────────────────────────

  /** Re-watches every folder's `.gitignore` and the HEAD that governs it. */
  private watchRepositories(): void {
    const generation = (this.repoGeneration += 1);
    for (const disposable of this.repoWatchers) {
      disposable.dispose();
    }
    this.repoWatchers = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      // The filter reads the root `.gitignore`, so any edit changes scope.
      const ignore = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".gitignore"),
      );
      const rescope = () =>
        this.schedule("git:ignore", REPO_DEBOUNCE_MS, "A .gitignore change", () =>
          this.model.rescope(),
        );
      this.repoWatchers.push(
        ignore,
        ignore.onDidChange(rescope),
        ignore.onDidCreate(rescope),
        ignore.onDidDelete(rescope),
      );

      this.dispatch("A repository lookup", async () => {
        const head = await resolveGitHead(folder.uri.fsPath);
        if (generation !== this.repoGeneration) {
          return;
        }
        // A worktree's HEAD may live outside the workspace; this exact pattern still watches it.
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.dirname(head)), path.basename(head)),
        );
        const handler = () =>
          this.schedule("git:head", REPO_DEBOUNCE_MS, "A branch change", () =>
            this.onGitHeadChanged(),
          );
        this.repoWatchers.push(watcher, watcher.onDidChange(handler), watcher.onDidCreate(handler));
      });
    }
  }

  // ── dispatch & scheduling ────────────────────────────────────────────────

  /** Owns synchronous throws and rejections because VS Code does not await event callbacks. */
  private dispatch(subject: string, work: () => Promise<void> | void): void {
    try {
      const running = work();
      if (running !== undefined) {
        void running.catch((error: unknown) => {
          this.onError(`${subject} could not be processed.`, error);
        });
      }
    } catch (error) {
      this.onError(`${subject} could not be processed.`, error);
    }
  }

  /** Collapses a burst on `key` into one run, `delay` after the last of them. */
  private schedule(
    key: string,
    delay: number,
    subject: string,
    work: () => Promise<void> | void,
  ): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.dispatch(subject, work);
      }, delay),
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  dispose(): void {
    // Retire in-flight HEAD lookups before they can register orphaned watchers.
    this.repoGeneration += 1;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const disposable of [...this.disposables, ...this.repoWatchers]) {
      disposable.dispose();
    }
    this.disposables = [];
    this.repoWatchers = [];
  }
}
