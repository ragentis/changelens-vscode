import type * as vscode from "vscode";
import type { DiskStat } from "../core/files";
import { normalizeKey } from "../core/paths";
import { type BaselineRead, type BaselineStore, matchesDisk } from "../storage";
import type { WorkspaceFilter } from "../tracking/filter";
import type { FileStateReader, OpaqueState, TextState } from "./fileState";
import type { ModelContext } from "./modelContext";
import type { BomFlags, FileStatus, OpaqueReason } from "./pendingFile";
import { diffPending, opaquePending } from "./pendingFile";
import type { TrackedFiles } from "./trackedFiles";

/** Preserves an opaque baseline's reason, distinguishing contentless files from lost baselines. */
function baselineReason(baseline: BaselineRead): OpaqueReason {
  return baseline.kind === "opaque" ? baseline.reason : "lostBaseline";
}

/**
 * The only builder of `PendingFile`: other collaborators change current or baseline state, then
 * ask this class to derive the resulting review.
 */
export class PendingDeriver {
  private readonly store: BaselineStore;
  private readonly reader: FileStateReader;
  private readonly tracked: TrackedFiles;
  private readonly filter: WorkspaceFilter;

  constructor(private readonly context: ModelContext) {
    this.store = context.store;
    this.reader = context.reader;
    this.tracked = context.tracked;
    this.filter = context.filter;
  }

  async recompute(uri: vscode.Uri, silent = false): Promise<void> {
    const key = normalizeKey(uri.fsPath);
    if (!this.filter.isTracked(uri)) {
      this.tracked.removePending(key);
      if (!silent) {
        this.context.fire();
      }
      return;
    }

    const state = await this.reader.read(uri);
    const baseline = await this.store.readBaseline(key);
    switch (state.kind) {
      case "missing":
        this.applyMissing(key, uri, baseline);
        break;
      case "unreadable":
        this.applyUnreadable(key, uri, baseline);
        break;
      case "opaque":
        this.applyOpaque(key, uri, state, baseline);
        break;
      default:
        await this.applyText(key, uri, state, baseline);
        break;
    }

    if (!silent) {
      this.context.fire();
    }
  }

  private applyMissing(key: string, uri: vscode.Uri, baseline: BaselineRead): void {
    if (baseline.kind === "none") {
      this.tracked.removePending(key);
    } else if (baseline.kind === "text") {
      this.setDiff(key, uri, "deleted", baseline.text, "", { baseline: baseline.hadBom });
    } else {
      // Keep deletions visible even when their baseline cannot provide text.
      this.setOpaque(key, uri, "deleted", baselineReason(baseline));
    }
  }

  private applyUnreadable(key: string, uri: vscode.Uri, baseline: BaselineRead): void {
    if (baseline.kind === "none") {
      this.tracked.removePending(key);
    } else {
      this.setOpaque(key, uri, "modified", "unreadableFile");
    }
  }

  private applyOpaque(
    key: string,
    uri: vscode.Uri,
    state: OpaqueState,
    baseline: BaselineRead,
  ): void {
    if (baseline.kind === "none") {
      this.setOpaque(key, uri, "added", state.reason, { stat: state.stat });
      return;
    }

    const entry = this.store.entry(key);
    if (baseline.kind === "opaque" && entry !== undefined && matchesDisk(entry, state.stat)) {
      this.tracked.removePending(key);
      return;
    }

    const reason = baseline.kind === "unreadable" ? "lostBaseline" : state.reason;
    this.setOpaque(key, uri, "modified", reason, { stat: state.stat });
  }

  private async applyText(
    key: string,
    uri: vscode.Uri,
    state: TextState,
    baseline: BaselineRead,
  ): Promise<void> {
    this.tracked.setCurrent(key, state.text);
    // Open documents hide the BOM, so fall back to the last disk reading.
    const currentHadBom = state.disk?.hadBom ?? this.tracked.disk(key)?.hadBom;

    if (baseline.kind === "none") {
      this.setDiff(key, uri, "added", "", state.text, { current: currentHadBom });
      return;
    }

    if (baseline.kind !== "text") {
      this.setOpaque(key, uri, "modified", baselineReason(baseline), { text: state.text });
      return;
    }

    if (baseline.text !== state.text) {
      this.setDiff(key, uri, "modified", baseline.text, state.text, {
        baseline: baseline.hadBom,
        current: currentHadBom,
      });
      return;
    }

    if (currentHadBom !== undefined && currentHadBom !== baseline.hadBom) {
      // A BOM-only change has no reviewable hunk, so fold it into the baseline.
      await this.store.setText(uri.fsPath, state.text, currentHadBom);
    }

    // Proven identical, so the stat becomes a valid shortcut for the next activation.
    if (state.disk) {
      this.store.markClean(key, state.disk.stat);
    }
    this.tracked.removePending(key);
  }

  private setDiff(
    key: string,
    uri: vscode.Uri,
    status: FileStatus,
    baselineText: string,
    currentText: string,
    bom: BomFlags = {},
  ): void {
    const pending = diffPending(key, uri, status, baselineText, currentText, bom);
    if (pending) {
      this.tracked.setPending(key, pending);
    } else {
      this.tracked.removePending(key);
    }
  }

  private setOpaque(
    key: string,
    uri: vscode.Uri,
    status: FileStatus,
    reason: OpaqueReason,
    current: { text?: string; stat?: DiskStat } = {},
  ): void {
    this.tracked.setPending(key, opaquePending(key, uri, status, reason, current));
  }
}
