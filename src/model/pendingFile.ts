import * as crypto from "node:crypto";
import type * as vscode from "vscode";
import type { Hunk } from "../core/diff";
import { computeHunks, countLines } from "../core/diff";
import { detectEol, splitLines } from "../core/text";
import type { UnifiedView } from "../core/unified";
import { buildUnified } from "../core/unified";

export type FileStatus = "added" | "modified" | "deleted";

/**
 * Why a pending file has no diff. `binary` and `tooLarge` are the only reasons persisted with a
 * baseline; `lostBaseline` and `unreadableFile` are derived while comparing the two sides.
 */
export type OpaqueReason = "binary" | "tooLarge" | "lostBaseline" | "unreadableFile";

/** One file awaiting review: everything the UI needs to show and act on a change. */
export interface PendingFile {
  key: string;
  uri: vscode.Uri;
  status: FileStatus;
  hunks: Hunk[];
  signatures: string[];
  added: number;
  removed: number;
  /** Non-null means the file has no reviewable diff, and says why. */
  opaqueReason: OpaqueReason | null;
  /**
   * Text excludes the BOM. ChangeLens restores it only when recreating a deleted file; existing
   * file reverts use `WorkspaceEdit`, leaving encoding and BOM to VS Code. Accept records the
   * current mark.
   */
  baselineHadBom: boolean;
  currentHadBom: boolean;
  baselineText: string;
  currentText: string;
  unified: UnifiedView | null;
  eol: string;
}

/** Byte order marks for the two sides, as far as either is known. */
export interface BomFlags {
  baseline?: boolean | undefined;
  current?: boolean | undefined;
}

/** Builds a text review, or returns `undefined` when both sides are identical. */
export function diffPending(
  key: string,
  uri: vscode.Uri,
  status: FileStatus,
  baselineText: string,
  currentText: string,
  bom: BomFlags = {},
): PendingFile | undefined {
  const currentLines = splitLines(currentText);
  const hunks = computeHunks(splitLines(baselineText), currentLines);
  if (hunks.length === 0) {
    return undefined;
  }

  const counts = countLines(hunks);
  const baselineHadBom = bom.baseline ?? false;

  return {
    key,
    uri,
    status,
    hunks,
    signatures: hunks.map(hunkSignature),
    added: counts.added,
    removed: counts.removed,
    opaqueReason: null,
    baselineHadBom,
    // An editor buffer never exposes the mark, so fall back to what the baseline recorded.
    currentHadBom: bom.current ?? baselineHadBom,
    baselineText,
    currentText,
    unified: buildUnified(currentLines, hunks),
    eol: detectEol(currentText || baselineText),
  };
}

/** Builds a review whose content is unavailable or deliberately unstored. */
export function opaquePending(
  key: string,
  uri: vscode.Uri,
  status: FileStatus,
  reason: OpaqueReason,
  currentText = "",
): PendingFile {
  return {
    key,
    uri,
    status,
    hunks: [],
    signatures: [],
    added: 0,
    removed: 0,
    opaqueReason: reason,
    baselineHadBom: false,
    currentHadBom: false,
    baselineText: "",
    currentText,
    unified: null,
    eol: detectEol(currentText),
  };
}

/**
 * Identifies a hunk by its content rather than its position, so a command issued against a
 * stale view either matches the same change or matches nothing.
 */
function hunkSignature(hunk: Hunk): string {
  return crypto
    .createHash("sha1")
    .update(`${hunk.baseStart}\u0000${hunk.baseLines.join("\n")}\u0000${hunk.currLines.join("\n")}`)
    .digest("hex");
}
