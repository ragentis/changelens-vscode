import * as vscode from "vscode";
import type { DiskStat } from "../core/files";
import { isInside, normalizeKey } from "../core/paths";
import { textDigest } from "../core/text";
import type { BaselineStore } from "../storage";
import type { WorkspaceFilter } from "../tracking/filter";
import { documentText, openDocument } from "./documents";
import type { FileState, FileStateReader, StatResult } from "./fileState";
import type { ModelContext } from "./modelContext";
import type { TrackedFiles } from "./trackedFiles";

function currentStat(state: FileState): DiskStat | undefined {
  if (state.kind === "text") {
    return state.disk?.stat;
  }
  return state.kind === "opaque" ? state.stat : undefined;
}

/**
 * Whether a reading still matches the snapshot. `found` is absent when the reading found no file,
 * which only matches a snapshot that found none either.
 *
 * Unlike the stat shortcuts elsewhere, which only postpone a comparison, a wrong answer here
 * overwrites the baseline and no later pass can find it.
 */
function matchesSnapshot(recorded: StatResult | undefined, found: DiskStat | undefined): boolean {
  if (recorded === undefined) {
    return false;
  }
  if (recorded.kind === "missing" || found === undefined) {
    return recorded.kind === "missing" && found === undefined;
  }

  return (
    recorded.kind === "stat" &&
    found.size === recorded.stat.size &&
    found.mtimeMs === recorded.stat.mtimeMs
  );
}

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

  /**
   * What each path is right now. The caller decides when this is taken, because it is only proof
   * of anything in relation to the check it is paired with.
   */
  async snapshotDisk(uris: readonly vscode.Uri[]): Promise<Map<string, StatResult>> {
    const recorded = new Map<string, StatResult>();
    for (const uri of uris) {
      recorded.set(normalizeKey(uri.fsPath), await this.reader.stat(uri));
    }
    return recorded;
  }

  /**
   * Adopts what Git left on disk, for paths Git itself wrote. A path Git deleted drops its
   * baseline rather than staying behind as a pending deletion.
   *
   * A path whose file no longer matches its snapshot is left alone: something wrote it after Git's
   * ownership was established, and adopting that write is exactly what must never happen.
   */
  async adoptGitWrites(
    uris: readonly vscode.Uri[],
    recorded: ReadonlyMap<string, StatResult>,
  ): Promise<void> {
    for (const uri of uris) {
      const key = normalizeKey(uri.fsPath);
      // An unsaved buffer outranks the file underneath it, as it does for any other external write.
      if (!this.filter.isTracked(uri) || openDocument(uri)?.isDirty === true) {
        continue;
      }

      const state = await this.reader.read(uri, true);
      if (state.kind === "unreadable" || !(await this.unwritten(uri, recorded.get(key), state))) {
        continue;
      }

      if (state.kind === "missing") {
        this.store.delete(key);
        this.tracked.forgetContent(key);
      } else {
        await this.storeBaselineFrom(uri, state);
      }
      this.tracked.removePending(key);
    }

    this.context.warnIfCrowded();
    await this.store.flush();
  }

  /**
   * Whether the file still holds what the snapshot recorded, asked around the read rather than
   * before it. A reading stats before it reads, so a write landing between those two would
   * otherwise be adopted: the stat would be Git's while the content already belonged to whoever
   * wrote it. The second reading is what rules that out.
   */
  private async unwritten(
    uri: vscode.Uri,
    recorded: StatResult | undefined,
    state: FileState,
  ): Promise<boolean> {
    if (!matchesSnapshot(recorded, currentStat(state))) {
      return false;
    }

    const after = await this.reader.stat(uri);
    if (after.kind === "unreadable") {
      return false;
    }
    return matchesSnapshot(recorded, after.kind === "stat" ? after.stat : undefined);
  }

  async storeBaselineFrom(uri: vscode.Uri, known?: FileState): Promise<void> {
    const state = known ?? (await this.reader.read(uri, true));
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

    this.tracked.setDisk(key, { digest: textDigest(state.text), hadBom: state.disk?.hadBom });
    // Clean buffers too: a reset cleared what the model last saw there, and without it the next
    // keystroke has nothing to be rebased against and is reviewed as an external change.
    if (doc) {
      this.tracked.setCurrent(key, documentText(doc));
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
