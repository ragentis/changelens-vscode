import { normalizeKey } from "../core/paths";

export interface RootMapping {
  /** Matching open folder for each stored root, in stored-root order. */
  mapped: (string | undefined)[];
  /** Currently open folders that matched no stored root. */
  arrived: string[];
}

/**
 * Matches stored roots to open folders by normalized path only. A path change leaves the old root
 * unmatched and reports the new one as arrived.
 *
 * Moves, renames, and project swaps are indistinguishable, and folder names are not unique. A
 * heuristic match could make Revert restore another project's content.
 *
 * Used only while loading the index; in-session folder changes are rescoped with fresh baselines.
 */
export function mapRoots(storedRoots: string[], currentRoots: string[]): RootMapping {
  const taken = new Set<number>();
  const mapped = storedRoots.map((stored) => {
    const at = currentRoots.findIndex(
      (root, index) => !taken.has(index) && normalizeKey(root) === normalizeKey(stored),
    );
    if (at < 0) {
      return undefined;
    }
    taken.add(at);
    return currentRoots[at];
  });
  return { mapped, arrived: currentRoots.filter((_, index) => !taken.has(index)) };
}
