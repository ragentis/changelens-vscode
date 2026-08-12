import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { isErrno, writeFileAtomic } from "../core/files";

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

// ── cache ──────────────────────────────────────────────────────────────────

/** Least-recently-used text cache with a byte budget, so a large workspace cannot fill memory. */
class TextCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly budget: number) {}

  /** Approximated from UTF-16 code units, which is close enough to bound a cache. */
  private static sizeOf(text: string): number {
    return text.length * 2;
  }

  private drop(hash: string): void {
    const text = this.entries.get(hash);
    if (text !== undefined) {
      this.bytes -= TextCache.sizeOf(text);
      this.entries.delete(hash);
    }
  }

  get(hash: string): string | undefined {
    const text = this.entries.get(hash);
    if (text === undefined) {
      return undefined;
    }
    this.entries.delete(hash);
    this.entries.set(hash, text);
    return text;
  }

  put(hash: string, text: string): void {
    this.drop(hash);
    this.entries.set(hash, text);
    this.bytes += TextCache.sizeOf(text);
    // The newest entry may exceed the budget by itself. Older entries are still evicted, but
    // keeping this one prevents the cache from becoming useless for content larger than its
    // configured budget.
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.budget || oldest === hash) {
        return;
      }
      this.drop(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/**
 * Content-addressed gzip storage. Knows nothing about files or the workspace: a blob is text
 * identified by the hash of that text, which is what makes deduplication and collection work.
 */
export class BlobStore {
  private readonly cache: TextCache;
  /** Blobs a read proved wrong: the next write of that hash must not trust the file on disk. */
  private readonly suspect = new Set<string>();
  /** Set while collection runs, so a blob adopted mid-pass is not treated as an orphan. */
  private adoptedDuringCollect: Set<string> | undefined;

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
      // Gzip's CRC covers corruption; this also catches a blob that is not what it claims to be.
      if (hashText(text) !== hash) {
        this.suspect.add(hash);
        return undefined;
      }
      this.suspect.delete(hash);
      this.cache.put(hash, text);
      return text;
    } catch (error) {
      // A blob that is simply absent is nothing to distrust: the write path finds no file and
      // stores it anyway. Remembering every one of those would grow the set for the whole session.
      if (!isErrno(error, "ENOENT")) {
        this.suspect.add(hash);
      }
      return undefined;
    }
  }

  /** Stores the text if it is not already there and returns its hash. */
  async write(text: string): Promise<string> {
    const hash = hashText(text);
    this.adoptedDuringCollect?.add(hash);
    if (!(await this.isStored(hash))) {
      await this.store(hash, text);
    }
    this.cache.put(hash, text);
    return hash;
  }

  /**
   * A blob a read already proved wrong does not count as stored: accepting the file would leave
   * the corruption in place and the baseline would be unreadable again after a restart.
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
   * Removes old storage entries not referenced by the current index. Writes that overlap the sweep
   * protect their hash through `adoptedDuringCollect`, while the age cutoff also preserves newly
   * created files. The adoption set is installed before the first await so writes can register as
   * soon as collection starts.
   *
   * One pass at a time: that single set is what a concurrent call would take over and then clear
   * away, leaving the pass still running with nothing to protect its writes. The store queues its
   * callers so that cannot happen.
   */
  async collect(referenced: Set<string>): Promise<void> {
    const adopted = new Set<string>();
    this.adoptedDuringCollect = adopted;
    try {
      await this.sweep(referenced, adopted);
    } finally {
      this.adoptedDuringCollect = undefined;
    }
  }

  private async sweep(referenced: Set<string>, adopted: Set<string>): Promise<void> {
    const cutoff = Date.now() - GC_MIN_AGE_MS;
    for (const bucket of await readdirOrEmpty(this.root)) {
      await this.sweepBucket(bucket, cutoff, referenced, adopted);
    }
  }

  private async sweepBucket(
    bucket: string,
    cutoff: number,
    referenced: Set<string>,
    adopted: Set<string>,
  ): Promise<void> {
    const bucketPath = path.join(this.root, bucket);
    const files = await readdirOrEmpty(bucketPath);
    let removed = 0;
    for (const file of files) {
      // Every unprotected entry is a collection candidate: an orphaned blob, an abandoned temp
      // file, or a leftover from an earlier layout. The age cutoff is the final guard for a write
      // in flight.
      const hash = file.endsWith(".gz") ? bucket + file.slice(0, -3) : undefined;
      if (hash !== undefined && (referenced.has(hash) || adopted.has(hash))) {
        continue;
      }
      if (await removeIfOlderThan(path.join(bucketPath, file), cutoff)) {
        removed += 1;
      }
    }
    if (removed === files.length) {
      await fs.rmdir(bucketPath).catch(() => undefined);
    }
  }
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => []);
}

async function removeIfOlderThan(target: string, cutoff: number): Promise<boolean> {
  try {
    if ((await fs.stat(target)).mtimeMs >= cutoff) {
      return false;
    }
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
