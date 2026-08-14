import * as vscode from "vscode";
import type { ChangeModel } from "../model";

/**
 * What happens when Git rewrites the workspace behind the extension's back. Kept out of the
 * activation wiring so the decision can be exercised without an extension host.
 */

export const RESET_BASELINE = "Reset Baseline";
export const KEEP_PENDING = "Keep Pending Changes";

export const BRANCH_CHANGED_PROMPT =
  "The Git branch changed while ChangeLens has pending changes. Reset the baseline to the current workspace?";

export const BRANCH_CHANGED_DETAIL =
  "Keeping the baseline will show every file rewritten by the branch switch as a pending change.";

/** A branch switch rewrites files wholesale; those writes are not agent changes. */
export async function handleGitHeadChanged(model: ChangeModel): Promise<void> {
  if (!model.ready) {
    return;
  }
  if (!model.hasChanges) {
    await model.captureBaseline(false);
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    BRANCH_CHANGED_PROMPT,
    { modal: true, detail: BRANCH_CHANGED_DETAIL },
    RESET_BASELINE,
    KEEP_PENDING,
  );
  if (answer === RESET_BASELINE) {
    await model.captureBaseline(false);
  }
}
