import * as path from "node:path";
import * as vscode from "vscode";
import { dirPrefix, normalizeKey } from "../core/paths";
import { rebaseBaseline } from "../core/rebase";
import { detectEol, splitLines } from "../core/text";
import type { BaselineStore } from "../storage";
import type { WorkspaceFilter } from "../tracking/filter";
import type { BaselineCapture } from "./baselineCapture";
import { documentText, openDocument } from "./documents";
import type { FileStateReader } from "./fileState";
import type { DeferredEvent, FileWorkQueue } from "./fileWork";
import type { ModelContext } from "./modelContext";
import type { PendingDeriver } from "./pendingDeriver";
import type { TrackedFiles } from "./trackedFiles";

function rebasePath(from: string, target: string, to: string): string {
  const relative = path.relative(from, target);
  return relative === "" ? to : path.join(to, relative);
}

type Move = { oldUri: vscode.Uri; newUri: vscode.Uri };

/**
 * Routes external disk changes into review and folds editor-owned edits and file operations into
 * the baseline.
 */
export class FileEvents {
  private readonly store: BaselineStore;
  private readonly reader: FileStateReader;
  private readonly tracked: TrackedFiles;
  private readonly filter: WorkspaceFilter;
  private readonly work: FileWorkQueue;

  constructor(
    private readonly context: ModelContext,
    private readonly deriver: PendingDeriver,
    private readonly capture: BaselineCapture,
  ) {
    this.store = context.store;
    this.reader = context.reader;
    this.tracked = context.tracked;
    this.filter = context.filter;
    this.work = context.work;
  }

  // ── changes from outside the editor ──────────────────────────────────────

  /** Treats non-editor disk writes as external changes. */
  handleDiskWrite(uri: vscode.Uri): Promise<void> {
    if (!this.filter.isTracked(uri) || this.work.defer(uri)) {
      return Promise.resolve();
    }

    const key = normalizeKey(uri.fsPath);

    return this.work.enqueue(key, async () => {
      const state = await this.reader.read(uri, true);
      if (state.kind === "text") {
        const seen = this.tracked.disk(key);
        // The BOM counts: comparing text alone could leave a stale BOM in the baseline.
        if (seen && seen.text === state.text && seen.hadBom === state.disk?.hadBom) {
          return;
        }
        this.tracked.setDisk(key, { text: state.text, hadBom: state.disk?.hadBom });
      }

      const doc = openDocument(uri);
      if (doc && doc.isDirty) {
        // Unsaved buffer wins until the user resolves the conflict; do not touch the file.
        return;
      }
      await this.deriver.recompute(uri);
    });
  }

  handleDiskDelete(uri: vscode.Uri): Promise<void> {
    if (this.work.defer(uri)) {
      return Promise.resolve();
    }

    const key = normalizeKey(uri.fsPath);
    if (!this.store.has(key) && !this.tracked.pending(key)) {
      return Promise.resolve();
    }

    return this.work.enqueue(key, async () => {
      this.tracked.forgetContent(key);
      await this.deriver.recompute(uri);
    });
  }

  // ── changes the user makes in the editor ─────────────────────────────────

  /** Folds VS Code buffer edits into the baseline instead of reporting them as hunks. */
  handleBufferChange(doc: vscode.TextDocument): Promise<void> {
    if (!this.filter.isTracked(doc.uri) || this.work.defer(doc.uri)) {
      return Promise.resolve();
    }

    const key = normalizeKey(doc.uri.fsPath);

    return this.work.enqueue(key, async () => {
      const next = documentText(doc);
      const prev = this.tracked.current(key);
      if (prev === next) {
        return;
      }

      if (prev !== undefined && next !== this.tracked.disk(key)?.text) {
        await this.rebaseOverBufferEdit(key, doc.uri, prev, next);
      }

      this.tracked.setCurrent(key, next);
      await this.deriver.recompute(doc.uri);
    });
  }

  /** Rebases the user's edit onto the baseline, leaving only changes they did not make. */
  private async rebaseOverBufferEdit(
    key: string,
    uri: vscode.Uri,
    prev: string,
    next: string,
  ): Promise<void> {
    const baseline = await this.store.readBaseline(key);
    if (baseline.kind !== "text") {
      return;
    }

    const eol = detectEol(baseline.text);
    const rebased = rebaseBaseline(
      splitLines(baseline.text),
      splitLines(prev),
      splitLines(next),
    ).join(eol);
    if (rebased === baseline.text) {
      return;
    }

    // Buffer rebases must not bypass the blob size limit. Keeping the old baseline reports
    // `tooLarge` until the content shrinks instead of storing forbidden content.
    if (this.filter.exceedsMaxSize(rebased)) {
      return;
    }

    await this.store.setText(uri.fsPath, rebased, baseline.hadBom);
  }

  /** Save and open only record known content and finish synchronously, so they need no queue. */
  handleSave(doc: vscode.TextDocument): void {
    if (!this.filter.isTracked(doc.uri)) {
      return;
    }

    const key = normalizeKey(doc.uri.fsPath);
    // VS Code preserves the existing BOM on save, so the last disk reading remains valid.
    this.tracked.setDisk(key, { text: documentText(doc), hadBom: this.tracked.disk(key)?.hadBom });
  }

  handleDocumentOpened(doc: vscode.TextDocument): void {
    if (!this.filter.isTracked(doc.uri)) {
      return;
    }

    const key = normalizeKey(doc.uri.fsPath);
    const text = documentText(doc);

    this.tracked.setCurrentIfUnknown(key, text);
    if (!doc.isDirty && this.tracked.disk(key) === undefined) {
      this.tracked.setDisk(key, { text, hadBom: undefined });
    }
  }

  // ── file operations the editor performs ──────────────────────────────────

  /**
   * Per-file queues cover each item, not the folder walk between them. Joining the whole handler
   * keeps `drain` from flushing the index halfway through an editor operation.
   */
  private joinedOperation(work: () => Promise<void>): Promise<void> {
    return this.work.join(work());
  }

  /** Adopts or forgets editor file operations instead of reporting them as external changes. */
  handleEditorCreate(uris: readonly vscode.Uri[]): Promise<void> {
    return this.joinedOperation(async () => {
      for (const uri of uris) {
        if (!this.filter.isTracked(uri) || this.work.defer(uri, "adopt")) {
          continue;
        }

        await this.adopt(uri);
      }
      this.context.fire();
    });
  }

  handleEditorDelete(uris: readonly vscode.Uri[]): Promise<void> {
    return this.joinedOperation(async () => {
      for (const uri of uris) {
        if (this.work.defer(uri, "forget")) {
          continue;
        }

        await this.work.enqueue(normalizeKey(uri.fsPath), () => this.forget(uri));
      }
      this.context.fire();
    });
  }

  handleEditorRename(moves: readonly Move[]): Promise<void> {
    return this.joinedOperation(async () => {
      for (const move of moves) {
        // Both sides have to be parked; `||` would short-circuit and drop the destination.
        const parkedOld = this.work.defer(move.oldUri, "forget");
        const parkedNew = this.work.defer(move.newUri, "adopt");
        if (parkedOld || parkedNew) {
          continue;
        }

        await this.carryMove(move);
      }
      this.context.fire();
    });
  }

  /** Moves every baseline and record under `oldUri`, then settles whatever else the move landed on. */
  private async carryMove(move: Move): Promise<void> {
    const carried = new Set<string>();
    for (const key of this.keysUnder(move.oldUri.fsPath)) {
      const from = this.pathOf(key);
      if (from === undefined) {
        continue;
      }

      const to = rebasePath(move.oldUri.fsPath, from, move.newUri.fsPath);
      carried.add(normalizeKey(to));
      // Queue on the source key: an in-flight buffer rebase writes the old path, so moving first
      // would resurrect that entry and leave a phantom deletion.
      await this.work.enqueue(key, async () => {
        this.store.rename(key, to);
        this.tracked.rename(key, normalizeKey(to));
        await this.deriver.recompute(vscode.Uri.file(to), true);
      });
    }

    await this.settleDestination(move.newUri, carried);
  }

  /**
   * Adopts uncarried destinations without a baseline as user-created. The decision stays per file
   * because a folder can mix new files with carried changes that must remain pending.
   */
  private async settleDestination(uri: vscode.Uri, carried: Set<string>): Promise<void> {
    const targets = await this.expand(uri);
    if (targets.length === 0) {
      // Recompute a destination that disappeared between the rename and this handler.
      await this.queuedRecompute(uri);
      return;
    }

    for (const target of targets) {
      const key = normalizeKey(target.fsPath);
      if (carried.has(key)) {
        continue;
      }

      // Never adopt over a baseline: that would silently accept an overwritten tracked file.
      if (this.filter.isTracked(target) && !this.store.has(key)) {
        await this.adoptFile(target);
        continue;
      }
      await this.queuedRecompute(target);
    }
  }

  /** Adds a created path to the baseline, including folder contents. */
  private async adopt(uri: vscode.Uri): Promise<void> {
    for (const target of await this.expand(uri)) {
      await this.adoptFile(target);
    }
  }

  /** Callers own the scope check: neither the store nor this knows what is excluded. */
  private adoptFile(uri: vscode.Uri): Promise<void> {
    const key = normalizeKey(uri.fsPath);
    return this.work.enqueue(key, async () => {
      await this.capture.storeBaselineFrom(uri);
      this.tracked.removePending(key);
    });
  }

  /** Expands a created or moved folder because VS Code emits one event for the whole tree. */
  private async expand(uri: vscode.Uri): Promise<vscode.Uri[]> {
    const stated = await this.reader.stat(uri);
    if (stated.kind !== "stat") {
      return [];
    }

    if (!stated.isDirectory) {
      return [uri];
    }

    const prefix = dirPrefix(uri.fsPath);
    return (await this.context.listWorkspaceFiles()).filter((target) =>
      normalizeKey(target.fsPath).startsWith(prefix),
    );
  }

  // ── replay & shared lookups ──────────────────────────────────────────────

  /** Re-raises an event a capture parked, against the baseline the capture finished building. */
  async replay(event: DeferredEvent): Promise<void> {
    if (event.kind === "forget") {
      this.forget(event.uri);
      return;
    }

    if (event.kind === "adopt" && this.filter.isTracked(event.uri)) {
      await this.adopt(event.uri);
      return;
    }

    await this.queuedRecompute(event.uri);
  }

  /** A silent recompute taking its turn behind whatever else is already queued for the file. */
  private queuedRecompute(uri: vscode.Uri): Promise<void> {
    return this.work.enqueue(normalizeKey(uri.fsPath), () => this.deriver.recompute(uri, true));
  }

  /**
   * Returns every key at or below `fsPath`. VS Code emits one event for a renamed or deleted
   * folder, so its descendants must be resolved here.
   */
  private keysUnder(fsPath: string): string[] {
    const root = normalizeKey(fsPath);
    const prefix = dirPrefix(fsPath);
    const keys = new Set([...this.store.keys(), ...this.tracked.keys()]);
    return [...keys].filter((key) => key === root || key.startsWith(prefix));
  }

  /** Returns the recorded path with its original editor-provided casing. */
  private pathOf(key: string): string | undefined {
    return this.store.entry(key)?.path ?? this.tracked.pending(key)?.uri.fsPath;
  }

  /** Drops every trace of a path, and of anything inside it when the path is a folder. */
  private forget(uri: vscode.Uri): void {
    for (const key of this.keysUnder(uri.fsPath)) {
      this.store.delete(key);
      this.tracked.delete(key);
    }
  }
}
