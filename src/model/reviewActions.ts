import * as vscode from "vscode";
import type { Hunk } from "../core/diff";
import { BOM, splitLines } from "../core/text";
import type { BaselineStore } from "../storage";
import { documentText, replaceLines, wholeRange } from "./documents";
import type { FileStateReader } from "./fileState";
import type { ModelContext } from "./modelContext";
import type { PendingDeriver } from "./pendingDeriver";
import type { PendingFile } from "./pendingFile";
import type { TrackedFiles } from "./trackedFiles";

/** Applies review decisions to either the baseline or the user's file. */
export class ReviewActions {
  private readonly store: BaselineStore;
  private readonly reader: FileStateReader;
  private readonly tracked: TrackedFiles;

  constructor(
    private readonly context: ModelContext,
    private readonly deriver: PendingDeriver,
  ) {
    this.store = context.store;
    this.reader = context.reader;
    this.tracked = context.tracked;
  }

  acceptFile(key: string): Promise<void> {
    return this.accept(key, false);
  }

  revertFile(key: string): Promise<boolean> {
    return this.revert(key, false);
  }

  /**
   * `bulk` defers notification and flush to the caller. Both are workspace-wide, so paying them
   * per file would repeatedly serialize and redraw the whole review.
   */
  private async accept(key: string, bulk: boolean): Promise<void> {
    const file = this.tracked.pending(key);
    if (!file) {
      return;
    }

    const store = this.store;
    if (file.status === "deleted") {
      store.delete(key);
      this.tracked.removePending(key);
    } else if (file.opaqueReason) {
      // Re-read instead of trusting the entry: an unreadable baseline recovers to a real one here.
      const state = await this.reader.read(file.uri);
      if (state.kind === "unreadable") {
        // Nothing to accept while the file cannot be read; leave the baseline as it is.
        return;
      }
      if (state.kind === "missing") {
        store.delete(key);
      } else if (state.kind === "opaque") {
        store.setOpaque(file.uri.fsPath, state.reason, state.stat);
      } else {
        await store.setText(file.uri.fsPath, state.text, state.disk?.hadBom);
      }
      this.tracked.removePending(key);
    } else {
      await store.setText(file.uri.fsPath, file.currentText, file.currentHadBom);
    }

    await this.deriver.recompute(file.uri, bulk);
    // Accepting an addition can grow the baseline.
    this.context.warnIfCrowded();
    if (!bulk) {
      await store.flush();
    }
  }

  async acceptHunk(key: string, signature: string): Promise<boolean> {
    const found = this.resolveHunk(key, signature);
    // A completely deleted file has no per-hunk accept: splicing its sole hunk would store an empty
    // baseline while the deletion stayed pending, so a later revert would recreate an empty file.
    // Accept the whole file instead.
    if (!found || found.file.opaqueReason || found.file.status === "deleted") {
      return false;
    }

    const { file, hunk } = found;
    const baseline = splitLines(file.baselineText);
    baseline.splice(hunk.baseStart, hunk.baseLines.length, ...hunk.currLines);

    await this.store.setText(file.uri.fsPath, baseline.join(file.eol), file.currentHadBom);
    await this.deriver.recompute(file.uri);
    this.context.warnIfCrowded();
    await this.store.flush();
    return true;
  }

  async revertHunk(key: string, signature: string): Promise<boolean> {
    const found = this.resolveHunk(key, signature);
    if (!found || found.file.opaqueReason || found.file.status === "deleted") {
      return false;
    }

    const { file, hunk } = found;
    const doc = await vscode.workspace.openTextDocument(file.uri);
    if (documentText(doc) !== file.currentText) {
      await this.deriver.recompute(file.uri);
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    const { range, text } = replaceLines(
      doc,
      hunk.currStart,
      hunk.currLines.length,
      hunk.baseLines,
    );

    edit.replace(file.uri, range, text);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      this.tracked.setCurrent(key, documentText(doc));
      await this.deriver.recompute(file.uri);
    }
    return applied;
  }

  private async revert(key: string, bulk: boolean): Promise<boolean> {
    const file = this.tracked.pending(key);
    if (!file) {
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    if (file.opaqueReason) {
      if (file.status !== "added" || !file.currentStat) {
        return false;
      }
      const state = await this.reader.read(file.uri);
      if (
        state.kind !== "opaque" ||
        state.stat.size !== file.currentStat.size ||
        state.stat.mtimeMs !== file.currentStat.mtimeMs
      ) {
        await this.deriver.recompute(file.uri, bulk);
        return false;
      }
      edit.deleteFile(file.uri, { ignoreIfNotExists: true });
    } else if (file.status === "deleted") {
      edit.createFile(file.uri, {
        overwrite: false,
        contents: Buffer.from(
          file.baselineHadBom ? BOM + file.baselineText : file.baselineText,
          "utf8",
        ),
      });
    } else {
      // Added and modified reverts destroy current content; reject if it changed since review.
      const doc = await vscode.workspace.openTextDocument(file.uri);
      if (documentText(doc) !== file.currentText) {
        await this.deriver.recompute(file.uri, bulk);
        return false;
      }
      if (file.status === "added") {
        edit.deleteFile(file.uri, { ignoreIfNotExists: true });
      } else {
        edit.replace(file.uri, wholeRange(doc), file.baselineText);
      }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await this.deriver.recompute(file.uri, bulk);
    }
    return applied;
  }

  async acceptAll(): Promise<void> {
    for (const file of this.tracked.allPending()) {
      await this.accept(file.key, true);
    }

    await this.store.flush();
    this.context.fire();
  }

  async revertAll(): Promise<string[]> {
    const failed: string[] = [];
    for (const file of this.tracked.allPending()) {
      const ok = await this.revert(file.key, true);
      if (!ok) {
        failed.push(vscode.workspace.asRelativePath(file.uri));
      }
    }

    this.context.fire();
    return failed;
  }

  /** Resolves a signature against current state; missing means the issuing view is stale. */
  private resolveHunk(
    key: string,
    signature: string,
  ): { file: PendingFile; hunk: Hunk } | undefined {
    const file = this.tracked.pending(key);
    if (!file) {
      return undefined;
    }

    const index = file.signatures.indexOf(signature);
    if (index < 0) {
      return undefined;
    }

    const hunk = file.hunks[index];
    return hunk ? { file, hunk } : undefined;
  }
}
