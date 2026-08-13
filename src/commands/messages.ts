import * as vscode from "vscode";
import type { ReviewMode } from "../config";
import type { OpaqueReason, PendingFile } from "../model";

/**
 * Everything the commands put in front of the user, including the button labels, which are
 * compared against the answer a dialog returns and so have to be one string, not two.
 */

export const CAPTURE_BASELINE = "Capture Baseline";
export const DELETE_FILE = "Delete File";
export const ACCEPT_ALL = "Accept All";
export const REVERT_ALL = "Revert All";
export const RESET_BASELINE = "Reset Baseline";

const NO_CONTENT_TO_REVERT =
  "ChangeLens: this file is tracked without content, so it cannot be reverted.";

export const REVERT_BLOCKED: Record<OpaqueReason, string> = {
  binary: NO_CONTENT_TO_REVERT,
  tooLarge: NO_CONTENT_TO_REVERT,
  lostBaseline:
    "ChangeLens: the stored baseline for this file is missing or unreadable, so it cannot be reverted. Accept the file to start tracking it from its current state.",
  unreadableFile:
    "ChangeLens: this file could not be read, so it cannot be reverted. It may be locked by another program.",
};

export const NO_BLOCK_AT_CURSOR =
  "ChangeLens: put the cursor inside a changed block first. Nothing was accepted or reverted.";

export const NO_REVIEWABLE_EDITOR =
  "ChangeLens: this editor has no reviewable block. Open a file with pending changes first.";

export const NO_STORED_CONTENT =
  "ChangeLens: this file is tracked without content, so its previous version cannot be shown.";

export const STALE_HUNK =
  "ChangeLens: that change is no longer current. The view has been refreshed.";

export const STALE_FILE =
  "ChangeLens: the file changed since this diff was computed, so nothing was reverted. Review it again.";

export const INCOMPLETE_BASELINE =
  "ChangeLens: the baseline is incomplete, so accepting or reverting could act on files it never recorded. Capture the baseline again first.";

export const REBASELINE_PROMPT =
  "Reset the ChangeLens baseline to the current workspace? All pending changes will be treated as accepted.";

/** Files listed in a confirmation before the rest are summarized. */
const PREVIEW_LIMIT = 10;

const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  unified: "Unified",
  diffEditor: "Diff Editor",
};

export function reviewModeChanged(mode: ReviewMode): string {
  return `ChangeLens review mode: ${REVIEW_MODE_LABELS[mode]}`;
}

export function deleteAddedFile(file: PendingFile): string {
  return `Delete ${vscode.workspace.asRelativePath(file.uri)}? It did not exist in the baseline.`;
}

export function acceptAllPrompt(count: number): string {
  return `Accept all changes in ${fileCount(count)}? They can no longer be reverted from here.`;
}

export function revertAllPrompt(files: readonly PendingFile[]): {
  message: string;
  detail: string;
} {
  const preview = files
    .slice(0, PREVIEW_LIMIT)
    .map((file) => vscode.workspace.asRelativePath(file.uri))
    .join("\n");
  const more = files.length > PREVIEW_LIMIT ? `\n… and ${files.length - PREVIEW_LIMIT} more` : "";
  return {
    message: `Revert all changes in ${fileCount(files.length)}?`,
    detail: `${preview}${more}\n\nFiles are modified but not saved.`,
  };
}

export function revertAllFailed(names: readonly string[]): string {
  return `ChangeLens could not revert ${fileCount(names.length)}: ${names.join(", ")}`;
}

export function warn(message: string): void {
  void vscode.window.showWarningMessage(message);
}

export function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}

function fileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}
