import type { DiskStat, OpaqueKind } from "../core/files";

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

/** Blob hashes referenced by text entries. */
export function textBlobs(entries: Iterable<BaselineEntry>): Set<string> {
  const blobs = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "text") {
      blobs.add(entry.blob);
    }
  }

  return blobs;
}
