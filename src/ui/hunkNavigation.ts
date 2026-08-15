import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { clampSpan, placeHunks } from "./hunkGeometry";
import { fileKeyOf, isReviewUri, REVIEW_SCHEME } from "./schemes";

/** How long the reveal waits for a review document to reload before giving up on it. */
const RELOAD_WINDOW_MS = 1000;

/**
 * Follows a finished block action to the block that took its place, so the next change is on
 * screen and under the cursor. Only the editor the action came from moves: another group showing
 * the same file keeps the position its reader left it in.
 *
 * `index` is where the acted block sat in the review that issued the action: blocks are ordered by
 * position, so the block now at that index is the one after it, and acting on the last block
 * settles on the last one left.
 */
export function revealNextHunk(model: ChangeModel, key: string, index: number): void {
  const editor = vscode.window.activeTextEditor;
  const file = model.get(key);
  if (!editor || fileKeyOf(editor.document.uri) !== key || !file || file.hunks.length === 0) {
    return;
  }

  const target = Math.min(index, file.hunks.length - 1);
  revealHunk(editor, model, key, target);
  // A review document reloads after the model change, and the reveal placed before it arrives is
  // scrolled away with the content it was aimed at.
  afterReload(key, () => {
    const settled = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document === editor.document,
    );
    if (settled) {
      revealHunk(settled, model, key, target);
    }
  });
}

/** Moves through Unified review blocks like the native diff editor, wrapping at either end. */
export function revealAdjacentHunk(model: ChangeModel, direction: "previous" | "next"): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== REVIEW_SCHEME) {
    return;
  }

  const key = fileKeyOf(editor.document.uri);
  const placements = placeHunks(model.get(key), REVIEW_SCHEME);
  if (placements.length === 0) {
    return;
  }

  const line = editor.selection.active.line;
  const found =
    direction === "next"
      ? placements.findIndex(({ block }) => block.start > line)
      : placements.findLastIndex(({ block }) => block.start < line);
  const target = found >= 0 ? found : direction === "next" ? 0 : placements.length - 1;
  revealHunk(editor, model, key, target);
}

function revealHunk(
  editor: vscode.TextEditor,
  model: ChangeModel,
  key: string,
  index: number,
): void {
  const placement = placeHunks(model.get(key), editor.document.uri.scheme)[index];
  if (!placement) {
    return;
  }

  const lastLine = Math.max(editor.document.lineCount - 1, 0);
  const { first } = clampSpan(placement.block, lastLine);
  const position = new vscode.Position(first, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
}

/**
 * Runs `work` once a review document of `key` has reloaded. The window is what ends the wait when
 * no reload arrives: accepting a block that removed nothing leaves the document as it was, and a
 * working file has no reload to wait for in the first place.
 */
function afterReload(key: string, work: () => void): void {
  let timer: NodeJS.Timeout | undefined;
  const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!isReviewUri(event.document.uri) || fileKeyOf(event.document.uri) !== key) {
      return;
    }
    clearTimeout(timer);
    subscription.dispose();
    work();
  });
  timer = setTimeout(() => {
    subscription.dispose();
  }, RELOAD_WINDOW_MS);
}
