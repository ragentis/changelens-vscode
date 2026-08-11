import * as path from "node:path";
import { isInside } from "../core/paths";
import type { BaselineEntry, DiskStat, OpaqueKind } from "./baselineEntry";
import { isBlobHash } from "./blobStore";
import { mapRoots } from "./rootMapping";

export const INDEX_VERSION = 1;

type StoredLocation = { root: number; path: string } | { path: string };

/**
 * Persisted counterpart of `BaselineEntry`: the payload intentionally mirrors the runtime model,
 * while the location is encoded separately so paths can be stored relative to a workspace root.
 */
type StoredFile = StoredLocation &
  (
    | { kind: "text"; blob: string; clean?: DiskStat }
    | { kind: "opaque"; reason: OpaqueKind; stat: DiskStat }
  );

export interface IndexFile {
  version: number;
  initialized: boolean;
  roots: string[];
  files: StoredFile[];
}

export interface ParsedIndex {
  initialized: boolean;
  /** The roots the entries were resolved against, which the store adopts as its own. */
  roots: string[];
  entries: BaselineEntry[];
  /** Open folders the index knew nothing about, so nothing under them has a baseline yet. */
  arrived: string[];
  /** Entries the validator rejected; those files will look newly added. */
  skipped: number;
  /**
   * The parsed entries or current roots no longer match the document on disk, so the store must
   * rewrite it even if this session makes no changes. Otherwise collection could remove blobs
   * still referenced by the stale index, or a root known only in memory could look newly arrived
   * again next time and silently baseline files that appeared in it meanwhile.
   */
  needsRewrite: boolean;
}

// ── writing ────────────────────────────────────────────────────────────────

function locate(entry: BaselineEntry, roots: string[]): StoredLocation {
  let best: { index: number; relative: string } | undefined;
  roots.forEach((root, index) => {
    if (!isInside(root, entry.path)) {
      return;
    }
    const relative = path.relative(root, entry.path);
    if (!best || relative.length < best.relative.length) {
      best = { index, relative };
    }
  });
  return best
    ? { root: best.index, path: best.relative.split(path.sep).join("/") }
    : { path: entry.path };
}

function writeEntry(entry: BaselineEntry, roots: string[]): StoredFile {
  const location = locate(entry, roots);
  if (entry.kind === "opaque") {
    return { ...location, kind: "opaque", reason: entry.reason, stat: entry.stat };
  }
  return entry.clean
    ? { ...location, kind: "text", blob: entry.blob, clean: entry.clean }
    : { ...location, kind: "text", blob: entry.blob };
}

export function serializeIndex(
  entries: Iterable<BaselineEntry>,
  roots: string[],
  initialized: boolean,
): IndexFile {
  return {
    version: INDEX_VERSION,
    initialized,
    roots: [...roots],
    files: [...entries].map((entry) => writeEntry(entry, roots)),
  };
}

// ── reading ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whole-document validation, because `files[].root` is a position in this array. Dropping the
 * bad elements instead would shift every later root, quietly re-pointing entries at a folder
 * they never belonged to; rejecting the index only costs a recapture.
 */
function isRootArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asDiskStat(value: unknown): DiskStat | undefined {
  if (!isRecord(value) || typeof value.size !== "number" || typeof value.mtimeMs !== "number") {
    return undefined;
  }
  const { size, mtimeMs } = value;
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || size < 0 || mtimeMs < 0) {
    return undefined;
  }
  return { size, mtimeMs };
}

/** The inverse of {@link locate}: undefined whenever the stored location cannot be trusted. */
function resolve(
  stored: Record<string, unknown>,
  rootMap: (string | undefined)[],
): string | undefined {
  if (typeof stored.path !== "string") {
    return undefined;
  }
  if (typeof stored.root === "number") {
    const root = rootMap[stored.root];
    if (root === undefined) {
      return undefined;
    }
    const absolute = path.resolve(root, stored.path.split("/").join(path.sep));
    // A hand-edited "../../elsewhere" must not produce an entry outside the workspace.
    return isInside(root, absolute) ? absolute : undefined;
  }
  // Without a root, a relative path would resolve against the process directory.
  return path.isAbsolute(stored.path) ? stored.path : undefined;
}

function readEntry(value: unknown, rootMap: (string | undefined)[]): BaselineEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const absolute = resolve(value, rootMap);
  if (absolute === undefined) {
    return undefined;
  }
  if (value.kind === "text" && isBlobHash(value.blob)) {
    const clean = asDiskStat(value.clean);
    return clean
      ? { path: absolute, kind: "text", blob: value.blob, clean }
      : { path: absolute, kind: "text", blob: value.blob };
  }
  const stat = asDiskStat(value.stat);
  if (
    value.kind === "opaque" &&
    stat &&
    (value.reason === "binary" || value.reason === "tooLarge")
  ) {
    return { path: absolute, kind: "opaque", reason: value.reason, stat };
  }
  return undefined;
}

/**
 * An entry belonging to a folder that is not open now. Dropping it is the design rather than a
 * defect, so it must not be counted among the entries the validator rejected.
 */
function isOrphaned(value: unknown, rootMap: (string | undefined)[]): boolean {
  return (
    isRecord(value) &&
    typeof value.root === "number" &&
    Number.isInteger(value.root) &&
    value.root >= 0 &&
    value.root < rootMap.length &&
    rootMap[value.root] === undefined
  );
}

/** Returns undefined when the document is not an index this version understands. */
export function parseIndex(raw: unknown, currentRoots: string[]): ParsedIndex | undefined {
  if (
    !isRecord(raw) ||
    raw.version !== INDEX_VERSION ||
    typeof raw.initialized !== "boolean" ||
    !isRootArray(raw.roots) ||
    !Array.isArray(raw.files)
  ) {
    return undefined;
  }
  const storedRoots = raw.roots;
  const roots = currentRoots.length > 0 ? currentRoots : storedRoots;
  const { mapped, arrived } = mapRoots(storedRoots, roots);
  const entries: BaselineEntry[] = [];
  let skipped = 0;
  for (const file of raw.files) {
    const entry = readEntry(file, mapped);
    if (entry) {
      entries.push(entry);
    } else if (!isOrphaned(file, mapped)) {
      skipped += 1;
    }
  }
  // Compared against what serializing would produce now rather than enumerating the reasons a
  // document can go stale, so a new reason cannot be forgotten here.
  const needsRewrite =
    entries.length !== raw.files.length ||
    roots.length !== storedRoots.length ||
    roots.some((root, index) => root !== storedRoots[index]);
  return { initialized: raw.initialized, roots, entries, arrived, skipped, needsRewrite };
}
