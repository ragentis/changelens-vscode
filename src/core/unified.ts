import type { Hunk } from "./diff";

export interface UnifiedHunk {
  index: number;
  /** First line of the hunk in the unified document. */
  start: number;
  removedStart: number;
  removedCount: number;
  addedStart: number;
  addedCount: number;
}

export interface UnifiedView {
  lines: string[];
  hunks: UnifiedHunk[];
}

/**
 * Interleaves baseline and current lines into one readable document: the whole file in context,
 * with deleted lines kept in place directly above their replacement.
 */
export function buildUnified(current: string[], hunks: Hunk[]): UnifiedView {
  const lines: string[] = [];
  const mapped: UnifiedHunk[] = [];
  let cursor = 0;

  for (const hunk of [...hunks].sort((a, b) => a.currStart - b.currStart)) {
    for (let i = cursor; i < hunk.currStart; i++) {
      const line = current[i];
      if (line === undefined) {
        throw new RangeError("Unified hunk starts outside the current document.");
      }
      lines.push(line);
    }
    const removedStart = lines.length;
    lines.push(...hunk.baseLines);
    const addedStart = lines.length;
    lines.push(...hunk.currLines);
    mapped.push({
      index: hunk.index,
      start: removedStart,
      removedStart,
      removedCount: hunk.baseLines.length,
      addedStart,
      addedCount: hunk.currLines.length,
    });
    cursor = hunk.currStart + hunk.currLines.length;
  }

  for (let i = cursor; i < current.length; i++) {
    const line = current[i];
    if (line === undefined) {
      throw new RangeError("Unified line index is outside the current document.");
    }
    lines.push(line);
  }

  return { lines, hunks: mapped };
}
