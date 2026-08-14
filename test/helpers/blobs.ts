import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Every blob under `blobsRoot`, across the buckets the store sharded them into. */
export async function blobFiles(blobsRoot: string): Promise<string[]> {
  const buckets = await fs.readdir(blobsRoot);
  const perBucket = await Promise.all(
    buckets.map(async (bucket) =>
      (await fs.readdir(path.join(blobsRoot, bucket))).map((file) =>
        path.join(blobsRoot, bucket, file),
      ),
    ),
  );
  return perBucket.flat();
}

/**
 * Blobs are kept for a grace period so a write still in flight is never collected. Ages every one
 * of them past it and reports what is there, which is what makes collection observable at all.
 */
export async function ageBlobs(blobsRoot: string): Promise<string[]> {
  const found = await blobFiles(blobsRoot);
  const old = new Date(Date.now() - 3_600_000);
  await Promise.all(found.map((file) => fs.utimes(file, old, old)));
  return found;
}
