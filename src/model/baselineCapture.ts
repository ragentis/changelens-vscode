import * as vscode from "vscode";
import { isInside, normalizeKey } from "../core/paths";
import type { BaselineStore } from "../storage";
import type { WorkspaceFilter } from "../tracking/filter";
import { documentText, openDocument } from "./documents";
import type { FileStateReader } from "./fileState";
import type { ModelContext } from "./modelContext";
import type { TrackedFiles } from "./trackedFiles";

/** Builds baseline snapshots; callers own ordering with derivation and queued work. */
export class BaselineCapture {
  private readonly store: BaselineStore;
  private readonly reader: FileStateReader;
  private readonly tracked: TrackedFiles;
  private readonly filter: WorkspaceFilter;

  /** `retry` re-runs a failed reset through the lifecycle chain, which only the model can enter. */
  constructor(
    private readonly context: ModelContext,
    private readonly retry: () => void,
  ) {
    this.store = context.store;
    this.reader = context.reader;
    this.tracked = context.tracked;
    this.filter = context.filter;
  }

  /**
   * Replaces the baseline and clears pending changes. The store stays uninitialized until the
   * snapshot is complete, so a partial capture cannot be reviewed.
   */
  async captureAll(initial: boolean): Promise<void> {
    const uris = await this.context.listWorkspaceFiles();
    this.context.warnIfCrowded(uris.length);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: initial ? "ChangeLens: capturing baseline…" : "ChangeLens: resetting baseline…",
      },
      async () => {
        this.store.reset();
        this.tracked.clear();
        for (const uri of uris) {
          await this.storeBaselineFrom(uri);
        }
      },
    );

    this.store.markInitialized();
    await this.store.flush();
    this.context.fire();
  }

  /**
   * Baselines roots absent from the loaded index. Retained roots keep their baselines, preserving
   * additions made while the extension was inactive.
   */
  async baselineArrivedRoots(): Promise<void> {
    const arrived = this.store.arrivedRoots;
    if (arrived.length === 0) {
      return;
    }

    await this.baselineUntracked((fsPath) => arrived.some((root) => isInside(root, fsPath)));
  }

  /** Baselines unknown in-scope files, optionally restricted by `within`. */
  async baselineUntracked(within?: (fsPath: string) => boolean): Promise<void> {
    const uris = await this.context.listWorkspaceFiles();
    // A restricted root import can still warn from the workspace-wide listing already available.
    this.context.warnIfCrowded(uris.length);

    for (const uri of uris) {
      if (within && !within(uri.fsPath)) {
        continue;
      }
      if (!this.store.has(normalizeKey(uri.fsPath))) {
        await this.storeBaselineFrom(uri);
      }
    }

    // Scope listings omit retained excluded baselines, so recheck the stored total after additions.
    this.context.warnIfCrowded();
  }

  async storeBaselineFrom(uri: vscode.Uri): Promise<void> {
    const state = await this.reader.read(uri, true);
    if (state.kind === "missing" || state.kind === "unreadable") {
      return;
    }
    if (state.kind === "opaque") {
      this.store.setOpaque(uri.fsPath, state.reason, state.stat);
      return;
    }

    const key = normalizeKey(uri.fsPath);
    // Capture dirty buffers as shown; using disk would misclassify their next edit as external.
    const doc = openDocument(uri);
    const buffer = doc?.isDirty === true ? documentText(doc) : undefined;
    if (buffer !== undefined && this.filter.exceedsMaxSize(buffer)) {
      // Dirty buffers bypass the reader's disk limit, so enforce the limit before storing one.
      this.store.setOpaque(uri.fsPath, "tooLarge", state.disk?.stat ?? { size: 0, mtimeMs: 0 });
      return;
    }

    await this.store.setText(uri.fsPath, buffer ?? state.text, state.disk?.hadBom);
    if (state.disk && buffer === undefined) {
      this.store.markClean(key, state.disk.stat);
    }

    this.tracked.setDisk(key, { text: state.text, hadBom: state.disk?.hadBom });
    if (buffer !== undefined) {
      this.tracked.setCurrent(key, buffer);
    }
  }

  /**
   * Reports an incomplete baseline, which remains unreviewable until capture succeeds.
   *
   * Initial failure stops activation before the watcher starts, so recovery requires reload;
   * later resets can retry through the lifecycle chain. The prompt is detached because awaiting
   * user input while holding that chain would block the retry it offers.
   */
  announceFailure(initial: boolean): void {
    const message = initial
      ? "ChangeLens could not finish capturing the baseline and is not tracking this window."
      : "ChangeLens could not finish resetting the baseline. Files it did not reach will appear as newly added, and review stays disabled until a capture succeeds.";

    void vscode.window
      .showWarningMessage(message, initial ? "Reload Window" : "Try Again")
      .then((choice) => {
        if (choice === "Reload Window") {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else if (choice === "Try Again") {
          this.retry();
        }
        return undefined;
      });
  }
}
