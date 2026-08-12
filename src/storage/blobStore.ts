import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { isErrno, writeFileAtomic } from "../core/files";
import {
  type CollectReport,
  GC_MIN_AGE_MS,
  newReport,
  readdirOrEmpty,
  removeIfOlderThan,
} from "./sweep";
import { TextCache } from "./textCache";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** The first 128 bits of SHA-256 make accidental collisions negligible for this local store. */
const HASH_LENGTH = 32;
const HASH_PATTERN = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`);

const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/** Rejects malformed hashes before path construction can escape the blob directory. */
export function isBlobHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/** Content-addressed gzip storage, independent of workspace layout. */
export class BlobStore {
  private readonly cache: TextCache;
  /** Hashes whose disk blob failed validation; the next write must repair it. */
  private readonly suspect = new Set<string>();
  /**
   * Deduplicates writes by hash. Identical content shares one path, and concurrent renames onto it
   * fail with `EPERM` on Windows.
   */
  private readonly storing = new Map<string, Promise<void>>();
  /** Text adopted during collection, retained in case the sweep removes its blob. */
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
      // Gzip checks integrity; the hash verifies identity.
      if (hashText(text) !== hash) {
        this.suspect.add(hash);
        return undefined;
      }
      this.suspect.delete(hash);
      this.cache.put(hash, text);
      return text;
    } catch (error) {
      // Missing blobs are repaired by writes without growing the session-long suspect set.
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

  /** A blob proven invalid must be rewritten even if its path still exists. */
  private async isStored(hash: string): Promise<boolean> {
    if (this.suspect.has(hash)) {
      return false;
    }
    return fs.access(this.pathOf(hash)).then(
      () => true,
      () => false,
    );
  }

  /**
   * Shares one write per hash. An existing target cannot turn failure into success because it may
   * be the corrupt blob being repaired; genuine rejection reaches every caller.
   */
  private store(hash: string, text: string): Promise<void> {
    const running = this.storing.get(hash);
    if (running) {
      return running;
    }
    const write = this.writeBlob(hash, text).finally(() => {
      // Only the current write clears its slot; a later one may have replaced it.
      if (this.storing.get(hash) === write) {
        this.storing.delete(hash);
      }
    });
    this.storing.set(hash, write);
    return write;
  }

  private async writeBlob(hash: string, text: string): Promise<void> {
    const target = this.pathOf(hash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, await gzip(Buffer.from(text, "utf8")));
    this.suspect.delete(hash);
  }

  // ── collection ───────────────────────────────────────────────────────────

  /**
   * Removes old unprotected entries. References, young files, and writes registered in
   * `adoptedDuringCollect` are protected; {@link restoreAdopted} repairs late adoptions.
   *
   * Callers must serialize passes because concurrent ones would replace the shared adoption map.
   * `report` lets the caller aggregate this sweep with other cleanup.
   */
  async collect(
    referenced: Set<string>,
    report: CollectReport = newReport(),
  ): Promise<CollectReport> {
    const adopted = new Map<string, string>();
    this.adoptedDuringCollect = adopted;
    try {
      await this.sweep(referenced, adopted, report);
    } finally {
      this.adoptedDuringCollect = undefined;
      await this.restoreAdopted(adopted);
    }
    return report;
  }

  /** Restores an adopted blob that disappeared after its write saw the old copy still present. */
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
      // The age cutoff is the final guard for unregistered writes still in flight.
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
