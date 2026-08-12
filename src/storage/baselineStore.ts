import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isErrno, writeFileAtomic } from "../core/files";
import { isInside, normalizeKey } from "../core/paths";
import { BOM, stripBom } from "../core/text";
import { type BaselineEntry, type DiskStat, matchesDisk, type OpaqueKind } from "./baselineEntry";
import { type ParsedIndex, parseIndex, serializeIndex } from "./baselineIndex";
import { BlobStore } from "./blobStore";

const PERSIST_DEBOUNCE_MS = 1000;

/**
 * Keeps opaque, absent, and unreadable baselines distinct. Conflating a lost blob with no baseline
 * would misclassify an existing file as newly added.
 *
 * `text` excludes the byte order mark; the blob retains it so restoration stays faithful.
 */
export type BaselineRead =
  | { kind: "text"; text: string; hadBom: boolean }
  | { kind: "opaque" }
  | { kind: "none" }
  | { kind: "unreadable" };

export interface BaselineStoreOptions {
  cacheBudget?: number;
  onError?: (message: string, error?: unknown) => void;
}

/**
 * Baseline index and content-addressed storage used to compute pending changes.
 */
export class BaselineStore {
  private entries = new Map<string, BaselineEntry>();
  private roots: string[] = [];
  private _arrivedRoots: string[] = [];
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private collecting: Promise<void> = Promise.resolve();
  /** Result shared with callers waiting for an index write already in flight. */
  private lastWriteOk = true;
  /** Blobs referenced by the index on disk, which can differ from memory during a write. */
  private persistedBlobs = new Set<string>();
  private _initialized = false;
  private readonly blobs: BlobStore;
  private readonly onError: (message: string, error?: unknown) => void;

  constructor(
    private readonly root: string,
    options: BaselineStoreOptions = {},
  ) {
    this.blobs = new BlobStore(path.join(root, "blobs"), options.cacheBudget);
    this.onError = options.onError ?? (() => undefined);
  }

  private get indexPath(): string {
    return path.join(this.root, "index.json");
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Open folders absent from the loaded index. Rename, replacement, and addition are
   * indistinguishable, so all are treated as newly arrived. Empty when no index was loaded.
   */
  get arrivedRoots(): string[] {
    return this._arrivedRoots;
  }

  /**
   * Sets roots used for relative paths and removes entries owned by closed folders. Must precede
   * {@link load} so stored roots can be matched to the folders currently open.
   *
   * When other roots remain open, removing one also removes its entries. Otherwise they would be
   * persisted as absolute paths and could return as stale baselines if the folder reopened.
   */
  setRoots(roots: string[]): void {
    // An empty list may be transient; retaining the roots prevents an intervening persist from
    // rewriting their entries as absolute paths.
    if (roots.length === 0) {
      return;
    }
    this.roots = roots;
    for (const [key, entry] of this.entries) {
      if (!roots.some((root) => isInside(root, entry.path))) {
        this.entries.delete(key);
        this.schedulePersist();
      }
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await this.blobs.ensure();
    const parsed = await this.readIndex();
    if (!parsed) {
      return;
    }
    this.roots = parsed.roots;
    this._arrivedRoots = parsed.arrived;
    this._initialized = parsed.initialized;
    for (const entry of parsed.entries) {
      this.entries.set(normalizeKey(entry.path), entry);
    }
    this.persistedBlobs = textBlobs(this.entries.values());
    if (parsed.skipped > 0) {
      const noun = parsed.skipped === 1 ? "file" : "files";
      const subject = parsed.skipped === 1 ? "That file" : "Those files";
      this.onError(
        `Could not load baseline data for ${parsed.skipped} ${noun}. ${subject} will appear as newly added.`,
      );
    }
    if (parsed.needsRewrite) {
      // Persist parser repairs even if the session makes no later changes.
      this.dirty = true;
      await this.flush();
    }
  }

  /** Reads and validates the index, returning undefined when it cannot be used. */
  private async readIndex(): Promise<ParsedIndex | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        this.onError(
          "Could not read the stored baseline. A new baseline will be captured from the workspace.",
          error,
        );
      }
      return undefined;
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      this.onError(
        "The stored baseline is corrupted. A new baseline will be captured from the workspace.",
        error,
      );
      return undefined;
    }
    const parsed = parseIndex(document, this.roots);
    if (!parsed) {
      this.onError(
        "The stored baseline format is not recognized. A new baseline will be captured from the workspace.",
      );
    }
    return parsed;
  }

  markInitialized(): void {
    if (!this._initialized) {
      this._initialized = true;
      this.schedulePersist();
    }
  }

  dispose(): void {
    void this.flush();
  }

  // ── entries ──────────────────────────────────────────────────────────────

  keys(): string[] {
    return [...this.entries.keys()];
  }

  entry(key: string): BaselineEntry | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async readBaseline(key: string): Promise<BaselineRead> {
    const entry = this.entries.get(key);
    if (!entry) {
      return { kind: "none" };
    }
    if (entry.kind === "opaque") {
      return { kind: "opaque" };
    }
    const stored = await this.blobs.read(entry.blob);
    if (stored === undefined) {
      return { kind: "unreadable" };
    }
    return { kind: "text", text: stripBom(stored), hadBom: stored.startsWith(BOM) };
  }

  /**
   * `text` excludes the BOM; `hadBom` restores it in the blob. Replacing the baseline also drops
   * the clean stat because it may no longer match the file.
   */
  async setText(fsPath: string, text: string, hadBom = false): Promise<void> {
    const blob = await this.blobs.write(hadBom ? BOM + text : text);
    this.entries.set(normalizeKey(fsPath), { path: fsPath, kind: "text", blob });
    this.schedulePersist();
  }

  /** Tracks contentless files by stat alone. */
  setOpaque(fsPath: string, reason: OpaqueKind, stat: DiskStat): void {
    this.entries.set(normalizeKey(fsPath), { path: fsPath, kind: "opaque", reason, stat });
    this.schedulePersist();
  }

  markClean(key: string, stat: DiskStat): void {
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== "text" || matchesDisk(entry, stat)) {
      return;
    }
    entry.clean = stat;
    // A clean stat is only a cache hint; persist it with the next write instead of after every scan.
    this.dirty = true;
  }

  delete(key: string): void {
    if (this.entries.delete(key)) {
      this.schedulePersist();
    }
  }

  rename(oldKey: string, newFsPath: string): void {
    const entry = this.entries.get(oldKey);
    if (!entry) {
      return;
    }
    this.entries.delete(oldKey);
    this.entries.set(normalizeKey(newFsPath), { ...entry, path: newFsPath });
    this.schedulePersist();
  }

  // ── bulk operations ──────────────────────────────────────────────────────

  /**
   * Drops all entries and leaves their blobs for collection. The store stays uninitialized until
   * capture finishes, so a partial baseline is never treated as complete.
   */
  reset(): void {
    if (this.entries.size === 0 && !this._initialized) {
      return;
    }
    this.entries.clear();
    this._initialized = false;
    this.schedulePersist();
  }

  /**
   * Queues best-effort removal of blobs referenced by neither memory nor the persisted index.
   *
   * Sweeps cannot overlap because {@link BlobStore} has one adoption map. Queueing also gives each
   * pass a fresh reference set.
   */
  async collectGarbage(): Promise<void> {
    this.collecting = this.collecting.then(async () => {
      try {
        await this.sweep();
      } catch (error) {
        // Per-entry failures are reported by the sweep; this catches a failure of the pass itself.
        this.onError("Baseline cleanup did not finish. It will be retried later.", error);
      }
      return undefined;
    });
    await this.collecting;
  }

  private async sweep(): Promise<void> {
    // Never collect after a failed persist; the surviving index may reference blobs absent from
    // memory.
    if (!(await this.flush())) {
      return;
    }
    // Memory and disk can name different blobs during a write. Protect their union; blobs needed
    // only by the older state become eligible on the next pass.
    const referenced = textBlobs(this.entries.values());
    for (const blob of this.persistedBlobs) {
      referenced.add(blob);
    }
    const report = await this.blobs.collect(referenced);
    if (report.failed > 0) {
      const noun = report.failed === 1 ? "file" : "files";
      this.onError(
        `Could not remove ${report.failed} unused baseline ${noun}. Cleanup will be retried later.`,
        report.error,
      );
    }
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private schedulePersist(): void {
    this.dirty = true;
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Persists current index state and reports whether the write this call waits for succeeded. */
  async flush(): Promise<boolean> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) {
      // Another caller may still be writing. Propagate its result so collection cannot follow a
      // failed persist.
      await this.writing;
      return this.lastWriteOk;
    }
    this.dirty = false;
    const payload = serializeIndex(this.entries.values(), this.roots, this._initialized);
    const blobs = textBlobs(this.entries.values());
    this.writing = this.writing.then(async () => {
      try {
        await writeFileAtomic(this.indexPath, JSON.stringify(payload));
        this.lastWriteOk = true;
        this.persistedBlobs = blobs;
      } catch (error) {
        // Keep the queue resolved so later writes run; `lastWriteOk` carries the failure.
        this.dirty = true;
        this.lastWriteOk = false;
        this.onError(
          "Could not save the baseline. Reviewed changes may appear as pending again after the window reloads.",
          error,
        );
      }
      return undefined;
    });
    await this.writing;
    return this.lastWriteOk;
  }
}

function textBlobs(entries: Iterable<BaselineEntry>): Set<string> {
  const blobs = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "text") {
      blobs.add(entry.blob);
    }
  }
  return blobs;
}
