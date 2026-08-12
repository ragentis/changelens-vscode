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
 * Keeps opaque, absent, and unreadable baselines distinct. Collapsing them into one null would
 * make a lost blob look like a new file and hide real changes.
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
 * The baseline every pending change is measured against: an index of tracked files on top of a
 * content-addressed blob store.
 */
export class BaselineStore {
  private entries = new Map<string, BaselineEntry>();
  private roots: string[] = [];
  private _arrivedRoots: string[] = [];
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private collecting: Promise<void> = Promise.resolve();
  /** Result shared with callers that only wait for an index write already in flight. */
  private lastWriteOk = true;
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
   * Open workspace folders absent from the loaded index. Their files have no baseline; a folder
   * that was renamed, replaced or newly opened looks the same, so the caller treats all three as
   * newly arrived. Empty when no index was loaded.
   */
  get arrivedRoots(): string[] {
    return this._arrivedRoots;
  }

  /**
   * Sets workspace roots used to store relative paths and discard entries owned by closed folders.
   * Must be called before {@link load} so stored roots can be matched to folders currently open.
   *
   * When other roots remain open, a root removed during a session loses its entries here. Keeping
   * them would serialize them as absolute paths, allowing stale baselines to return if the folder
   * were later reopened.
   */
  setRoots(roots: string[]): void {
    // Treat an empty list as a transient window state. Keeping the previous roots prevents an
    // intervening persist from rewriting their entries as absolute paths.
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
    if (parsed.skipped > 0) {
      const noun = parsed.skipped === 1 ? "file" : "files";
      const subject = parsed.skipped === 1 ? "That file" : "Those files";
      this.onError(
        `Could not load baseline data for ${parsed.skipped} ${noun}. ${subject} will appear as newly added.`,
      );
    }
    if (parsed.needsRewrite) {
      // Persist the parser's repairs even if this session makes no later changes.
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
   * `text` must be free of the byte order mark; `hadBom` puts it back into the stored blob.
   * Any previous clean stat is dropped, because the new baseline may not match the file.
   */
  async setText(fsPath: string, text: string, hadBom = false): Promise<void> {
    const blob = await this.blobs.write(hadBom ? BOM + text : text);
    this.entries.set(normalizeKey(fsPath), { path: fsPath, kind: "text", blob });
    this.schedulePersist();
  }

  /** Tracks a file whose content is deliberately not stored, identified by its stat alone. */
  setOpaque(fsPath: string, reason: OpaqueKind, stat: DiskStat): void {
    this.entries.set(normalizeKey(fsPath), { path: fsPath, kind: "opaque", reason, stat });
    this.schedulePersist();
  }

  /** Records that the file on disk was just proven identical to its text baseline. */
  markClean(key: string, stat: DiskStat): void {
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== "text" || matchesDisk(entry, stat)) {
      return;
    }
    entry.clean = stat;
    // A clean stat is only a cache hint; persist it with the next real write instead of scheduling
    // one after every scan.
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
   * Drops all entries but leaves their blobs for collection. The empty store is uninitialized so
   * a failed capture cannot be mistaken for a complete baseline on the next activation.
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
   * Queues best-effort removal of blobs no longer referenced by the persisted index.
   *
   * Sweeps cannot overlap because {@link BlobStore} has one adoption set. Queueing also lets each
   * sweep build a fresh reference set after the previous one finishes.
   */
  async collectGarbage(): Promise<void> {
    this.collecting = this.collecting.then(async () => {
      try {
        await this.sweep();
      } catch (error) {
        // Keep the queue usable after a best-effort failure; a later sweep can retry.
        this.onError(
          "Some unused baseline data could not be removed. Cleanup will be retried later.",
          error,
        );
      }
      return undefined;
    });
    await this.collecting;
  }

  private async sweep(): Promise<void> {
    // Never collect against state that failed to persist; the surviving index may still reference
    // blobs absent from memory.
    if (!(await this.flush())) {
      return;
    }
    const referenced = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.kind === "text") {
        referenced.add(entry.blob);
      }
    }
    await this.blobs.collect(referenced);
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
      // Even when `dirty` is false, another caller may still be writing. Propagate that result so
      // collection cannot run after a failed persist.
      await this.writing;
      return this.lastWriteOk;
    }
    this.dirty = false;
    const payload = serializeIndex(this.entries.values(), this.roots, this._initialized);
    this.writing = this.writing.then(async () => {
      try {
        await writeFileAtomic(this.indexPath, JSON.stringify(payload));
        this.lastWriteOk = true;
      } catch (error) {
        // Keep the queue resolved so later writes still run; callers receive the failure through
        // `lastWriteOk`.
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
