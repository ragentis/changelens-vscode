import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type DiskStat,
  isErrno,
  isTempFileFor,
  type OpaqueKind,
  writeFileAtomic,
} from "../core/files";
import { isInside, normalizeKey } from "../core/paths";
import { BOM, stripBom } from "../core/text";
import { type BaselineEntry, matchesDisk, textBlobs } from "./baselineEntry";
import { type ParsedIndex, parseIndex, serializeIndex } from "./baselineIndex";
import { BlobStore } from "./blobStore";
import {
  type CollectReport,
  GC_MIN_AGE_MS,
  newReport,
  readdirOrEmpty,
  removeIfOlderThan,
} from "./sweep";

const PERSIST_DEBOUNCE_MS = 1000;

/**
 * Keeps absent, unreadable, and contentless baselines distinct so a lost blob is not mistaken for
 * a new file. `text` excludes the BOM, which remains in the blob for restoration.
 */
export type BaselineRead =
  | { kind: "text"; text: string; hadBom: boolean }
  | { kind: "opaque"; reason: OpaqueKind }
  | { kind: "none" }
  | { kind: "unreadable" };

export interface BaselineStoreOptions {
  cacheBudget?: number;
  onError?: (message: string, error?: unknown) => void;
}

/** Baseline index and content-addressed storage for pending-change derivation. */
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
   * Open roots absent from the loaded index. Whether new, renamed, or replaced is unknowable, so
   * all are treated as newly arrived. Empty when no index was loaded.
   */
  get arrivedRoots(): string[] {
    return this._arrivedRoots;
  }

  /**
   * Sets roots before {@link load} can map stored paths. When roots remain, entries under closed
   * roots are removed so they cannot be persisted as absolute paths and return if reopened.
   */
  setRoots(roots: string[]): void {
    // An empty list may be transient; keep roots so an intervening persist cannot absolutize them.
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
      return { kind: "opaque", reason: entry.reason };
    }

    const stored = await this.blobs.read(entry.blob);
    if (stored === undefined) {
      return { kind: "unreadable" };
    }

    return { kind: "text", text: stripBom(stored), hadBom: stored.startsWith(BOM) };
  }

  /**
   * `text` excludes the BOM; `hadBom` restores it. Replacement drops the possibly stale clean stat.
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
   * Drops entries but leaves blobs for collection. The store remains uninitialized until capture
   * completes, preventing review of a partial baseline.
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
   * Queues best-effort cleanup of unused blobs and index temp files. Serialization protects
   * BlobStore's single adoption map and gives every pass a fresh reference set.
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
    // Skip collection after failed persistence: the surviving index may name blobs absent in memory.
    if (!(await this.flush())) {
      return;
    }

    // Protect the union of memory and disk references; their snapshots may differ during a write.
    const referenced = textBlobs(this.entries.values());
    for (const blob of this.persistedBlobs) {
      referenced.add(blob);
    }

    const report = newReport();
    await this.blobs.collect(referenced, report);
    await this.sweepAbandonedWrites(report);
    if (report.failed > 0) {
      const noun = report.failed === 1 ? "file" : "files";
      this.onError(
        `Could not remove ${report.failed} unused baseline ${noun}. Cleanup will be retried later.`,
        report.error,
      );
    }
  }

  /** Removes stale index temp files, which sit outside the blob sweep's tree. */
  private async sweepAbandonedWrites(report: CollectReport): Promise<void> {
    const cutoff = Date.now() - GC_MIN_AGE_MS;
    const indexName = path.basename(this.indexPath);
    for (const name of await readdirOrEmpty(this.root, report)) {
      if (isTempFileFor(name, indexName)) {
        await removeIfOlderThan(path.join(this.root, name), cutoff, report);
      }
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
      // Propagate an in-flight write's result so collection cannot follow failed persistence.
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
