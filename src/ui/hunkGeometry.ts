import type { Hunk } from "../core/diff";
import type { UnifiedHunk } from "../core/unified";
import type { PendingFile } from "../model";
import { BASE_SCHEME, REVIEW_SCHEME } from "./schemes";

/**
 * Where a block sits in a document, which differs per side: the unified view interleaves both
 * sides, the baseline counts removed lines, and the working file counts current ones. Lenses,
 * decorations, and the cursor commands all place the same block, so they place it from here.
 */

export type ReviewSide = "baseline" | "current" | "unified";

export interface LineSpan {
  start: number;
  /** Zero on a side that does not show these lines at all. */
  count: number;
}

export interface HunkPlacement {
  /** The whole block, which is what the cursor has to be inside to select it. */
  block: LineSpan;
  removed: LineSpan;
  added: LineSpan;
}

export function sideOf(scheme: string): ReviewSide {
  if (scheme === REVIEW_SCHEME) {
    return "unified";
  }
  return scheme === BASE_SCHEME ? "baseline" : "current";
}

/**
 * Places every block of `file` in a document of `scheme`, positioned like `file.hunks` so a
 * placement pairs with the hunk and signature of the same index. Empty when the document has no
 * block to show.
 */
export function placeHunks(file: PendingFile | undefined, scheme: string): HunkPlacement[] {
  if (!file || file.opaqueReason || file.status === "deleted") {
    return [];
  }
  const side = sideOf(scheme);
  const unified = side === "unified" ? file.unified : null;
  if (side === "unified" && !unified) {
    return [];
  }
  return file.hunks.map((hunk, index) => place(hunk, side, unified?.hunks[index]));
}

/** Clamps a span to a document that may be shorter, as the one marker line an empty side draws. */
export function clampSpan(span: LineSpan, lastLine: number): { first: number; last: number } {
  const first = Math.min(Math.max(span.start, 0), lastLine);
  return { first, last: Math.min(first + Math.max(span.count, 1) - 1, lastLine) };
}

function place(hunk: Hunk, side: ReviewSide, mapped: UnifiedHunk | undefined): HunkPlacement {
  if (mapped) {
    return {
      block: { start: mapped.start, count: mapped.removedCount + mapped.addedCount },
      removed: { start: mapped.removedStart, count: mapped.removedCount },
      added: { start: mapped.addedStart, count: mapped.addedCount },
    };
  }
  if (side === "baseline") {
    return {
      block: { start: hunk.baseStart, count: hunk.baseLines.length },
      removed: { start: hunk.baseStart, count: hunk.baseLines.length },
      added: { start: hunk.baseStart, count: 0 },
    };
  }
  return {
    block: { start: hunk.currStart, count: hunk.currLines.length },
    removed: { start: hunk.currStart, count: 0 },
    added: { start: hunk.currStart, count: hunk.currLines.length },
  };
}
