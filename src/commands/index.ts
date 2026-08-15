import * as vscode from "vscode";
import type { ChangeModel, PendingFile } from "../model";
import type { BaselineStore } from "../storage";
import { revealAdjacentHunk, revealNextHunk } from "../ui/hunkNavigation";
import { BASE_SCHEME, CURRENT_SCHEME, REVIEW_SCHEME, toReviewUri } from "../ui/schemes";
import {
  ACCEPT_ALL,
  acceptAllPrompt,
  CAPTURE_BASELINE,
  DELETE_FILE,
  deleteAddedFile,
  INCOMPLETE_BASELINE,
  info,
  NO_STORED_CONTENT,
  REBASELINE_PROMPT,
  RESET_BASELINE,
  REVERT_ALL,
  REVERT_BLOCKED,
  revertAllFailed,
  revertAllPrompt,
  reviewModeChanged,
  STALE_FILE,
  STALE_HUNK,
  warn,
} from "./messages";
import { hunkAtCursor, resolveFile } from "./targets";

export { resolveKey } from "./targets";

type CommandHandler = Parameters<typeof vscode.commands.registerCommand>[1];

type HunkAction = (key: string, signature: string) => Promise<void>;

/**
 * Opens the current file, or the baseline for a deletion. A contentless deletion has neither
 * version available to show.
 */
async function showPendingFile(
  file: PendingFile,
  options: vscode.TextDocumentShowOptions,
): Promise<void> {
  if (file.status !== "deleted") {
    await vscode.commands.executeCommand("vscode.open", file.uri, options);
    return;
  }
  if (file.opaqueReason) {
    warn(NO_STORED_CONTENT);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(toReviewUri(BASE_SCHEME, file.uri));
  await vscode.window.showTextDocument(doc, options);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  model: ChangeModel,
  store: BaselineStore,
): void {
  const register = (command: string, handler: CommandHandler) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  /**
   * Blocks review actions when the baseline is incomplete: unrecorded files look added, so
   * reverting them could delete user work.
   *
   * The model checks again on its lifecycle chain because a queued capture can fail after this
   * guard passes. Commands recheck after the model returns so a late refusal reports the incomplete
   * baseline instead of a stale diff or silent success.
   */
  const requireBaseline = (): boolean => {
    if (model.reviewable) {
      return true;
    }
    void vscode.window.showWarningMessage(INCOMPLETE_BASELINE, CAPTURE_BASELINE).then((choice) => {
      if (choice === CAPTURE_BASELINE) {
        // `captureBaseline` reports its own failure; detach this retry and suppress its rethrown
        // rejection.
        void model.captureBaseline(false).catch(() => undefined);
      }
      return undefined;
    });
    return false;
  };

  // ── opening a review ─────────────────────────────────────────────────────

  register("changelens.refresh", async () => {
    await model.reloadConfig();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "ChangeLens: refreshing…" },
      () => model.reconcile(false),
    );
  });

  register("changelens.openDiff", async (arg: unknown) => {
    const file = resolveFile(model, arg);
    if (!file) {
      return;
    }
    if (file.opaqueReason) {
      await showPendingFile(file, { preview: true });
      return;
    }
    if (model.config.reviewMode === "unified") {
      const doc = await vscode.workspace.openTextDocument(toReviewUri(REVIEW_SCHEME, file.uri));
      const firstChange = file.unified?.hunks.reduce(
        (first, hunk) => Math.min(first, hunk.start),
        Number.POSITIVE_INFINITY,
      );
      const selection =
        firstChange !== undefined && Number.isFinite(firstChange)
          ? new vscode.Range(firstChange, 0, firstChange, 0)
          : undefined;
      await vscode.window.showTextDocument(
        doc,
        selection ? { preview: true, selection } : { preview: true },
      );
      return;
    }
    const title = `${vscode.workspace.asRelativePath(file.uri)} (ChangeLens)`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      toReviewUri(BASE_SCHEME, file.uri),
      toReviewUri(CURRENT_SCHEME, file.uri),
      title,
      { preview: true },
    );
  });

  register("changelens.openFile", async (arg: unknown) => {
    const file = resolveFile(model, arg);
    if (file) {
      await showPendingFile(file, { preview: false });
    }
  });

  register("changelens.toggleReviewMode", async () => {
    const next = await model.toggleReviewMode();
    info(reviewModeChanged(next));
  });

  register("changelens.previousChange", () => revealAdjacentHunk(model, "previous"));
  register("changelens.nextChange", () => revealAdjacentHunk(model, "next"));

  // ── one block ────────────────────────────────────────────────────────────

  /** Where the block sits in the review the action was issued against, before it is acted on. */
  const hunkIndex = (key: string, signature: string): number => {
    return model.get(key)?.signatures.indexOf(signature) ?? -1;
  };

  const advance = (key: string, index: number): void => {
    if (index >= 0 && model.config.jumpToNextChange) {
      revealNextHunk(model, key, index);
    }
  };

  const acceptHunk: HunkAction = async (key, signature) => {
    if (!requireBaseline()) {
      return;
    }
    const index = hunkIndex(key, signature);
    if (!(await model.acceptHunk(key, signature))) {
      if (requireBaseline()) {
        warn(STALE_HUNK);
      }
      return;
    }
    advance(key, index);
  };

  const revertHunk: HunkAction = async (key, signature) => {
    if (!requireBaseline()) {
      return;
    }
    const index = hunkIndex(key, signature);
    if (!(await model.revertHunk(key, signature))) {
      if (requireBaseline()) {
        warn(STALE_FILE);
      }
      return;
    }
    advance(key, index);
  };

  const atCursor = async (act: HunkAction) => {
    const target = hunkAtCursor(model);
    if (!target.ok) {
      warn(target.message);
      return;
    }
    await act(target.key, target.signature);
  };

  register("changelens.acceptHunk", acceptHunk);
  register("changelens.revertHunk", revertHunk);
  register("changelens.acceptHunkAtCursor", () => atCursor(acceptHunk));
  register("changelens.revertHunkAtCursor", () => atCursor(revertHunk));

  // ── one file ─────────────────────────────────────────────────────────────

  register("changelens.acceptFile", async (arg: unknown) => {
    const file = resolveFile(model, arg);
    if (file && requireBaseline()) {
      await model.acceptFile(file.key);
      requireBaseline();
    }
  });

  register("changelens.revertFile", async (arg: unknown) => {
    const file = resolveFile(model, arg);
    if (!file) {
      return;
    }
    // An added opaque file needs no previous content and can follow the confirmed delete path.
    // Other opaque states have nothing stored to restore, and a new capture would only accept them.
    if (file.opaqueReason && file.status !== "added") {
      warn(REVERT_BLOCKED[file.opaqueReason]);
      return;
    }
    if (!requireBaseline()) {
      return;
    }
    if (file.status === "added") {
      const confirm = await vscode.window.showWarningMessage(
        deleteAddedFile(file),
        { modal: true },
        DELETE_FILE,
      );
      if (confirm !== DELETE_FILE) {
        return;
      }
    }
    if (!(await model.revertFile(file.key)) && requireBaseline()) {
      warn(STALE_FILE);
    }
  });

  // ── the whole review ─────────────────────────────────────────────────────

  register("changelens.acceptAll", async () => {
    const count = model.files.length;
    if (count === 0 || !requireBaseline()) {
      return;
    }
    const confirm = await vscode.window.showInformationMessage(
      acceptAllPrompt(count),
      { modal: true },
      ACCEPT_ALL,
    );
    if (confirm === ACCEPT_ALL) {
      await model.acceptAll();
      requireBaseline();
    }
  });

  register("changelens.revertAll", async () => {
    const files = model.files;
    if (files.length === 0 || !requireBaseline()) {
      return;
    }
    const { message, detail } = revertAllPrompt(files);
    const confirm = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      REVERT_ALL,
    );
    if (confirm !== REVERT_ALL) {
      return;
    }
    const failed = await model.revertAll();
    if (failed.length) {
      warn(revertAllFailed(failed));
    } else {
      requireBaseline();
    }
  });

  // ── view and baseline ────────────────────────────────────────────────────

  register("changelens.viewAsList", () => model.setViewMode("list"));
  register("changelens.viewAsTree", () => model.setViewMode("tree"));

  register("changelens.rebaseline", async () => {
    const confirm = await vscode.window.showWarningMessage(
      REBASELINE_PROMPT,
      { modal: true },
      RESET_BASELINE,
    );
    if (confirm !== RESET_BASELINE) {
      return;
    }
    try {
      await model.captureBaseline(false);
    } catch {
      // Capture already reports the failure and recovery action; suppress the rejection to avoid a
      // second, generic "command failed" notice.
      return;
    }
    // A reset can leave the store's largest batch of unreferenced blobs, so reclaim them now instead
    // of waiting for the next activation.
    await store.collectGarbage();
  });
}
