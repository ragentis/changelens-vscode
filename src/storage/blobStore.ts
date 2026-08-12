import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { isErrno, writeFileAtomic } from "../core/files";
import { TextCache } from "./textCache";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** Uses the first 128 bits of SHA-256; accidental collisions are negligible for a local blob store. */
const HASH_LENGTH = 32;
const HASH_PATTERN = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`);

const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
/** Protects newly created blobs and temp files from collection running alongside a write. */
const GC_MIN_AGE_MS = 60_000;

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/** Rejects malformed hashes before path construction can escape the blob directory. */
export function isBlobHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/**
 * Aggregates per-entry collection failures so one unreadable directory does not abort the pass
 * and the caller can report one error.
 */
export interface CollectReport {
  failed: number;
  error: unknown;
}

function note(report: CollectReport, error: unknown): void {
  report.failed += 1;
  report.error ??= error;
}

/**
 * Content-addressed gzip storage, independent of files and workspace layout.
 */
export class BlobStore {
  private readonly cache: TextCache;
  /** Blobs a read proved wrong: the next write of that hash must not trust the file on disk. */
  private readonly suspect = new Set<string>();
  /**
   * Blobs adopted during collection. Text is retained because a blob already selected for removal
   * may need to be restored after the pass.
   */
  private adoptedDuringCollect: Map<string, string> | undefined;

  constructor(
    private readonly root: string,
    cacheBudget: number = CACHE_BUDGET_BYTES,
  ) {
    this.cache = new TextCache(cacheBudget);
  }

  private pathOf(hash: string): string {
    return path.join(this.root, hash.slice(0, 2), `${hash.slice(2)}.gz`);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  // ── read & write ─────────────────────────────────────────────────────────

  /** Undefined when the blob is missing, unreadable, or does not match the hash it is filed under. */
  async read(hash: string): Promise<string | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const buffer = await fs.readFile(this.pathOf(hash));
      const text = (await gunzip(buffer)).toString("utf8");
      // Gzip's CRC catches corruption; the hash also verifies the blob's identity.
      if (hashText(text) !== hash) {
        this.suspect.add(hash);
        return undefined;
      }
      this.suspect.delete(hash);
      this.cache.put(hash, text);
      return text;
    } catch (error) {
      // Missing blobs need no suspect entry: the write path restores them, and remembering each
      // miss would grow the set for the whole session.
      if (!isErrno(error, "ENOENT")) {
        this.suspect.add(hash);
      }
      return undefined;
    }
  }

  /** Stores the text if it is not already there and returns its hash. */
  async write(text: string): Promise<string> {
    const hash = hashText(text);
    this.adoptedDuringCollect?.set(hash, text);
    if (!(await this.isStored(hash))) {
      await this.store(hash, text);
    }
    this.cache.put(hash, text);
    return hash;
  }

  /**
   * A blob already proven invalid does not count as stored, so the next write repairs it instead
   * of preserving corruption across restarts.
   */
  private async isStored(hash: string): Promise<boolean> {
    if (this.suspect.has(hash)) {
      return false;
    }
    return fs.access(this.pathOf(hash)).then(
      () => true,
      () => false,
    );
  }

  private async store(hash: string, text: string): Promise<void> {
    const target = this.pathOf(hash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, await gzip(Buffer.from(text, "utf8")));
    this.suspect.delete(hash);
  }

  // ── collection ───────────────────────────────────────────────────────────

  /**
   * Removes old entries outside the caller's protected set. Overlapping writes are protected by
   * `adoptedDuringCollect`; the age cutoff protects newly created files, and
   * {@link restoreAdopted} restores adoptions the sweep noticed too late. The map is installed
   * before the first await so writes can register immediately.
   *
   * Only one pass may run because concurrent passes would overwrite the shared adoption map.
   */
  async collect(referenced: Set<string>): Promise<CollectReport> {
    const adopted = new Map<string, string>();
    const report: CollectReport = { failed: 0, error: undefined };
    this.adoptedDuringCollect = adopted;
    try {
      await this.sweep(referenced, adopted, report);
    } finally {
      this.adoptedDuringCollect = undefined;
      await this.restoreAdopted(adopted);
    }
    return report;
  }

  /**
   * A late adoption can find a blob present after the sweep chose it for removal, skip writing, and
   * then lose the file. Restoring missing adopted blobs after the pass closes that race.
   */
  private async restoreAdopted(adopted: Map<string, string>): Promise<void> {
    for (const [hash, text] of adopted) {
      if (!(await this.isStored(hash))) {
        await this.store(hash, text);
      }
    }
  }

  private async sweep(
    referenced: Set<string>,
    adopted: Map<string, string>,
    report: CollectReport,
  ): Promise<void> {
    const cutoff = Date.now() - GC_MIN_AGE_MS;
    for (const bucket of await readdirOrEmpty(this.root, report)) {
      await this.sweepBucket(bucket, cutoff, referenced, adopted, report);
    }
  }

  private async sweepBucket(
    bucket: string,
    cutoff: number,
    referenced: Set<string>,
    adopted: Map<string, string>,
    report: CollectReport,
  ): Promise<void> {
    const bucketPath = path.join(this.root, bucket);
    const files = await readdirOrEmpty(bucketPath, report);
    let removed = 0;
    for (const file of files) {
      // Unprotected entries include orphaned blobs, abandoned temp files, and entries from older
      // layouts. The age cutoff is the final guard for writes in flight.
      const hash = file.endsWith(".gz") ? bucket + file.slice(0, -3) : undefined;
      if (hash !== undefined && (referenced.has(hash) || adopted.has(hash))) {
        continue;
      }
      if (await removeIfOlderThan(path.join(bucketPath, file), cutoff, report)) {
        removed += 1;
      }
    }
    if (removed === files.length) {
      // Bucket removal is optional; a concurrent write may make it non-empty, so ignore failure.
      await fs.rmdir(bucketPath).catch(() => undefined);
    }
  }
}

/** A missing directory has nothing to sweep and is not an error. */
async function readdirOrEmpty(dir: string, report: CollectReport): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      note(report, error);
    }
    return [];
  }
}

async function removeIfOlderThan(
  target: string,
  cutoff: number,
  report: CollectReport,
): Promise<boolean> {
  try {
    if ((await fs.stat(target)).mtimeMs >= cutoff) {
      return false;
    }
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    // Another remover reaching the entry first already achieved the desired result.
    if (!isErrno(error, "ENOENT")) {
      note(report, error);
    }
    return false;
  }
}
