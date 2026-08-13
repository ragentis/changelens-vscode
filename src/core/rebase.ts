import type { Op } from "./diff";
import { computeHunks, diffLines } from "./diff";

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function equalBlocks(ops: Op[]): Op[] {
  return ops.filter((op) => op.kind === "equal");
}

/**
 * Returns the unchanged block containing both current-side boundary positions. Boundaries that map
 * to different blocks cross a pending hunk and must not be folded; inclusive block ends keep
 * adjacent edits mappable.
 */
function containingBlock(blocks: Op[], start: number, end: number): Op | null {
  for (const block of blocks) {
    if (start >= block.bStart && end <= block.bStart + block.count) {
      return block;
    }
  }
  return null;
}

/**
 * Folds user edits between `prevCurrent` and `newCurrent` into the baseline without accepting
 * existing pending hunks. Only edits contained in unchanged regions are folded; overlaps stay
 * pending.
 */
export function rebaseBaseline(
  baseline: string[],
  prevCurrent: string[],
  newCurrent: string[],
): string[] {
  if (sameLines(baseline, prevCurrent)) {
    return newCurrent.slice();
  }
  if (sameLines(prevCurrent, newCurrent)) {
    return baseline.slice();
  }

  const blocks = equalBlocks(diffLines(baseline, prevCurrent));
  const userHunks = computeHunks(prevCurrent, newCurrent);
  const result = baseline.slice();

  for (let i = userHunks.length - 1; i >= 0; i--) {
    const hunk = userHunks[i];
    if (!hunk) {
      throw new RangeError("Rebase hunk index is outside the computed hunk range.");
    }
    const block = containingBlock(blocks, hunk.baseStart, hunk.baseStart + hunk.baseLines.length);
    if (!block) {
      continue;
    }
    const from = block.aStart + (hunk.baseStart - block.bStart);
    result.splice(from, hunk.baseLines.length, ...hunk.currLines);
  }

  return result;
}
