import * as vscode from "vscode";
import type { ChangeModel, PendingFile } from "../model";
import { clampSpan, placeHunks } from "../ui/hunkGeometry";
import { fileKeyOf } from "../ui/schemes";
import { NO_BLOCK_AT_CURSOR, NO_REVIEWABLE_EDITOR } from "./messages";

/**
 * What a command acts on. A menu passes the tree node or URI it was invoked from; the editor
 * toolbar passes nothing, so the target comes from the active editor instead.
 */

interface FileNodeLike {
  file: { key: string };
}

export type CursorHunk =
  | { ok: true; key: string; signature: string }
  | { ok: false; message: string };

function isFileNodeLike(value: unknown): value is FileNodeLike {
  if (typeof value !== "object" || value === null || !("file" in value)) {
    return false;
  }
  const { file } = value;
  return typeof file === "object" && file !== null && "key" in file && typeof file.key === "string";
}

export function resolveKey(model: ChangeModel, arg: unknown): string | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof vscode.Uri) {
    return fileKeyOf(arg);
  }
  if (isFileNodeLike(arg)) {
    return arg.file.key;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (!active) {
    return undefined;
  }
  const key = fileKeyOf(active);
  return model.get(key) ? key : undefined;
}

export function resolveFile(model: ChangeModel, arg: unknown): PendingFile | undefined {
  const key = resolveKey(model, arg);
  return key ? model.get(key) : undefined;
}

/**
 * Fallback for when diff CodeLens is off: resolve the block from the cursor instead. The cursor has
 * to be inside the block, because these commands sit in the editor toolbar where a click carries no
 * indication of which block it would hit.
 */
export function hunkAtCursor(model: ChangeModel): CursorHunk {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { ok: false, message: NO_REVIEWABLE_EDITOR };
  }
  const file = model.get(fileKeyOf(editor.document.uri));
  const placements = placeHunks(file, editor.document.uri.scheme);
  if (!file || placements.length === 0) {
    return { ok: false, message: NO_REVIEWABLE_EDITOR };
  }

  const lastLine = Math.max(editor.document.lineCount - 1, 0);
  const line = editor.selection.active.line;
  const hit = placements.findIndex((placement) => {
    const { first, last } = clampSpan(placement.block, lastLine);
    return line >= first && line <= last;
  });

  const signature = hit < 0 ? undefined : file.signatures[hit];
  return signature === undefined
    ? { ok: false, message: NO_BLOCK_AT_CURSOR }
    : { ok: true, key: file.key, signature };
}
