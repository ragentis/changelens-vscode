import * as vscode from "vscode";
import type { BaselineStore } from "../storage";
import type { TrackingConfig } from "../tracking/filter";
import { excludeGlob, readConfig, WorkspaceFilter } from "../tracking/filter";
import { FileStateReader } from "./fileState";
import { FileWorkQueue } from "./fileWork";
import { TrackedFiles } from "./trackedFiles";

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
  config: TrackingConfig;

  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.emitter.event;

  constructor(readonly store: BaselineStore) {
    this.config = readConfig();
    this.filter = new WorkspaceFilter(this.config);
    this.reader = new FileStateReader(store, this.filter);
  }

  fire(): void {
    this.emitter.fire();
  }

  /** Re-reads the settings and the open folders, then rebuilds the filter from both. */
  async applyConfig(): Promise<void> {
    this.config = readConfig();
    this.store.setRoots(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    );
    await this.filter.rebuild(this.config);
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
