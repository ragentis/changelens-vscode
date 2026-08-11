import { normalizeKey } from "../core/paths";

export interface RootMapping {
  /** Matching open folder for each stored root, in stored-root order. */
  mapped: (string | undefined)[];
  /** Currently open folders that matched no stored root. */
  arrived: string[];
}

/**
 * Matches stored roots to currently open folders by normalized path only. A path change leaves the
 * stored root unmatched and reports the new path as arrived.
 *
 * Intentionally avoids heuristics: moves, renames, and project swaps look identical. A wrong match
 * could diff one project against another project's baselines and let Revert restore the wrong
 * content. Folder names are not unique enough to disambiguate them.
 *
 * Used only while loading the index. Folder changes during a session are handled by rescoping,
 * which gives new folders fresh baselines.
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
