export interface DiskStat {
  size: number;
  mtimeMs: number;
}

export type OpaqueKind = "binary" | "tooLarge";

/**
 * `clean` is the file stat captured when its content was known to match the baseline. Its absence
 * forces a content comparison.
 */
export type BaselineEntry =
  | { path: string; kind: "text"; blob: string; clean?: DiskStat }
  | { path: string; kind: "opaque"; reason: OpaqueKind; stat: DiskStat };

export function matchesDisk(entry: BaselineEntry, stat: DiskStat): boolean {
  const known = entry.kind === "text" ? entry.clean : entry.stat;
  return known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs;
}
