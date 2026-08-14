import type * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { fileKeyOf, isReviewUri } from "./schemes";

/**
 * The two context keys the editor-title menus gate on. Kept apart from the activation wiring
 * because which menu entries appear is decided here, not by the `when` clauses alone.
 */
export interface ActiveFileContext {
  /** `changelens.activeFileHasChanges`: the working file itself is under review. */
  hasChanges: boolean;
  /** `changelens.activeFileHasHunks`: something is pending with a block to accept or revert. */
  hasHunks: boolean;
}

export function activeFileContext(
  model: ChangeModel,
  active: vscode.Uri | undefined,
): ActiveFileContext {
  const reviewed =
    active && (active.scheme === "file" || isReviewUri(active))
      ? model.get(fileKeyOf(active))
      : undefined;
  return {
    hasChanges: active?.scheme === "file" && reviewed !== undefined,
    // Deletions and contentless files are pending but have no block to accept or revert.
    hasHunks:
      reviewed !== undefined &&
      !reviewed.opaqueReason &&
      reviewed.status !== "deleted" &&
      reviewed.hunks.length > 0,
  };
}
