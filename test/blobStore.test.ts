import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BlobStore } from "../src/storage/blobStore";
import { must } from "./helpers/assert";
import { ageBlobs, blobFiles } from "./helpers/blobs";

// The store under test is handed the blob root directly, so `root` is already the bucket parent.
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-blobs-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * A reference set that starts a write the first time the sweep asks whether a blob is protected.
 * The write is queued as a microtask, so its adoption lands after the sweep has cleared the blob
 * for removal but before the removal itself — the interleaving adoption alone cannot cover.
 */
function referencesNothing(onFirstCheck: () => void): Set<string> {
  const referenced = new Set<string>();
  const has = referenced.has.bind(referenced);
  referenced.has = (value: string): boolean => {
    referenced.has = has;
    void Promise.resolve().then(onFirstCheck);
    return has(value);
  };
  return referenced;
}

test("a blob adopted while the sweep is removing it is written back", async () => {
  const store = new BlobStore(root);
  await store.ensure();
  const hash = await store.write("late\n");
  await ageBlobs(root);

  let adopting: Promise<string> = Promise.resolve(hash);
  await store.collect(
    referencesNothing(() => {
      adopting = store.write("late\n");
    }),
  );
  await adopting;

  expect(await blobFiles(root)).toHaveLength(1);
  // A second store starts with an empty cache, so this can only come off disk.
  expect(await new BlobStore(root).read(hash)).toBe("late\n");
});

test("collection reports what it could not scan", async () => {
  // A file where the blob directory should be: unreadable for a reason that is not "not there".
  const target = path.join(root, "not-a-directory");
  await fs.writeFile(target, "x");

  const report = await new BlobStore(target).collect(new Set());

  expect(report.failed).toBe(1);
  expect(report.error).toBeDefined();
});

test("a blob store with nothing in it reports no failures", async () => {
  const report = await new BlobStore(path.join(root, "never-created")).collect(new Set());

  expect(report).toEqual({ failed: 0, error: undefined });
});

test("concurrent writes of the same text share one store instead of racing for its path", async () => {
  const blobs = new BlobStore(root);
  await blobs.ensure();
  const text = "shared boilerplate\n".repeat(50);

  // Windows rejects the second rename onto a path the first is still placing, so an unshared
  // write fails here for content that was already stored.
  const [first, ...rest] = await Promise.all(Array.from({ length: 32 }, () => blobs.write(text)));
  const hash = must(first, "the hash every writer agreed on");

  expect(rest).toEqual(Array(31).fill(hash));
  expect(await blobFiles(root)).toHaveLength(1);
  // A second store starts with an empty cache, so this proves the bytes reached disk.
  expect(await new BlobStore(root).read(hash)).toBe(text);
});

test("a write that genuinely fails rejects every caller sharing it", async () => {
  const text = "unstorable\n";
  // Learn the bucket this text hashes into, then put a file where that directory has to go.
  const elsewhere = path.join(root, "elsewhere");
  const hash = await new BlobStore(elsewhere).write(text);
  const blocked = path.join(root, "blocked");
  await fs.mkdir(blocked, { recursive: true });
  await fs.writeFile(path.join(blocked, hash.slice(0, 2)), "x");

  const blobs = new BlobStore(blocked);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => blobs.write(text)));

  // Sharing one write must not turn a real failure into a success for the callers behind it.
  expect(results.map((result) => result.status)).toEqual(Array(8).fill("rejected"));
});
