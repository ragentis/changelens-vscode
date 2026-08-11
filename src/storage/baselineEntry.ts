export interface DiskStat {
  size: number;
  mtimeMs: number;
}

export type OpaqueKind = "binary" | "tooLarge";

/**
 * `clean` is the stat of the file at a moment its content was known to equal the baseline.
 * It is absent whenever that is unknown, which forces a real comparison instead of a guess.
 */
export type BaselineEntry =
  | { path: string; kind: "text"; blob: string; clean?: DiskStat }
  | { path: string; kind: "opaque"; reason: OpaqueKind; stat: DiskStat };

export function matchesDisk(entry: BaselineEntry, stat: DiskStat): boolean {
  const known = entry.kind === "text" ? entry.clean : entry.stat;
  return known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs;
}
