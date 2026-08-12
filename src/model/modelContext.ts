import * as vscode from "vscode";
import type { BaselineStore } from "../storage";
import type { ChangeLensConfig } from "../config";
import { excludeGlob, readConfig } from "../config";
import { WorkspaceFilter } from "../tracking/filter";
import { FileStateReader } from "./fileState";
import { FileWorkQueue } from "./fileWork";
import { TrackedFiles } from "./trackedFiles";

/** Coalesces bursts of checks without suppressing later warnings. */
const WARNING_INTERVAL_MS = 60_000;

/**
 * Shared model state and workspace access. Capture, events, derivation, and review intentionally
 * operate on the same tracked set, store, reader, and filter.
 */
export class ModelContext implements vscode.Disposable {
  readonly tracked = new TrackedFiles();
  readonly work = new FileWorkQueue();
  readonly filter: WorkspaceFilter;
  readonly reader: FileStateReader;
  /** Replaced wholesale by {@link applyConfig}, so it is read through the context, never copied. */
  config: ChangeLensConfig;

  private readonly emitter = new vscode.EventEmitter<void>();
  private lastWarning = 0;

  readonly onDidChange = this.emitter.event;

  constructor(readonly store: BaselineStore) {
    this.config = readConfig();
    this.filter = new WorkspaceFilter(this.config);
    this.reader = new FileStateReader(store, this.filter);
  }

  fire(): void {
    this.emitter.fire();
  }

  /** Rebuilds the filter before publishing config, so events cannot mix old scope with new limits. */
  async applyConfig(): Promise<void> {
    const config = readConfig();
    this.store.setRoots(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    );
    await this.filter.rebuild(config);
    this.config = config;
  }

  /**
   * Warns when a supplied candidate count, or the stored baseline size, exceeds the limit. Capture
   * passes its existing listing to warn before reading every file; repeated checks are throttled.
   */
  warnIfCrowded(count = this.store.size): void {
    const limit = this.config.maxTrackedFiles;
    if (count <= limit || Date.now() - this.lastWarning < WARNING_INTERVAL_MS) {
      return;
    }

    this.lastWarning = Date.now();
    void vscode.window.showWarningMessage(
      `ChangeLens is tracking ${count} files, above the configured limit of ${limit}. Add exclude patterns to keep the baseline small.`,
    );
  }

  /** Every in-scope file of every open folder. */
  async listWorkspaceFiles(): Promise<vscode.Uri[]> {
    const glob = excludeGlob(this.config.exclude);
    const found = await vscode.workspace.findFiles("**/*", glob);
    return found.filter((uri) => this.filter.isTracked(uri));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
