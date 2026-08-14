import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DiskStat } from "../src/core/files";
import { matchesDisk } from "../src/storage/baselineEntry";
import type { BaselineStoreOptions } from "../src/storage/baselineStore";
import { normalizeKey } from "../src/core/paths";
import { BaselineStore } from "../src/storage/baselineStore";
import { must } from "./helpers/assert";
import { deferred } from "./helpers/async";
import { ageBlobs, blobFiles } from "./helpers/blobs";

let root: string;
let workspace: string;

const blobsRoot = () => path.join(root, "blobs");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-"));
  workspace = path.join(root, "workspace");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function loaded(
  options: BaselineStoreOptions = {},
  roots: string[] = [workspace],
): Promise<BaselineStore> {
  const store = new BaselineStore(root, options);
  store.setRoots(roots);
  await store.load();
  return store;
}

function fsPath(name: string): string {
  return path.join(workspace, name);
}

function key(name: string): string {
  return normalizeKey(fsPath(name));
}

function blobOf(store: BaselineStore, name: string): string | undefined {
  const entry = store.entry(key(name));
  return entry?.kind === "text" ? entry.blob : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readIndex(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, "index.json"), "utf8"));
  if (!isRecord(parsed)) {
    throw new TypeError("index.json did not contain an object");
  }
  return parsed;
}

const stat = (size: number, mtimeMs: number): DiskStat => ({ size, mtimeMs });

const anyBlob: unknown = expect.any(String);

test("a stored baseline survives a reload", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\ntwo\n");
  store.markInitialized();
  await store.flush();

  const reloaded = await loaded();
  expect(reloaded.initialized).toBe(true);
  expect(await reloaded.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("an untracked file reads as none, a contentless one as opaque", async () => {
  const store = await loaded();
  store.setOpaque(fsPath("logo.png"), "binary", stat(42, 100));

  expect(await store.readBaseline(key("missing.ts"))).toEqual({ kind: "none" });
  expect(await store.readBaseline(key("logo.png"))).toEqual({
    kind: "opaque",
    reason: "binary",
  });
});

test("an opaque entry keeps its reason and stat across a reload", async () => {
  const store = await loaded();
  store.setOpaque(fsPath("huge.log"), "tooLarge", stat(9000, 123));
  await store.flush();

  const entry = (await loaded()).entry(key("huge.log"));
  expect(entry).toEqual({
    path: fsPath("huge.log"),
    kind: "opaque",
    reason: "tooLarge",
    stat: stat(9000, 123),
  });
});

test("the index stores paths relative to a workspace root", async () => {
  const store = await loaded();
  await store.setText(fsPath(path.join("src", "a.ts")), "one\n");
  await store.flush();

  expect((await readIndex()).files).toEqual([
    { root: 0, path: "src/a.ts", kind: "text", blob: anyBlob },
  ]);
});

test("a moved workspace folder loses its baselines and is reported as arrived", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  // The folder kept its name and moved under a new parent, which is not evidence of anything:
  // an unrelated project of the same name could just as well have been opened in its place.
  const moved = path.join(root, "moved", path.basename(workspace));
  const reloaded = await loaded({}, [moved]);

  expect(reloaded.size).toBe(0);
  expect(reloaded.arrivedRoots).toEqual([moved]);
  // Loading rewrote the index, so the old location is not left on disk to be reinterpreted.
  expect(await readIndex()).toMatchObject({ roots: [moved], files: [] });
});

test("a workspace folder that is still open keeps resolving to itself", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  // Two folders open, the original one second: position must not win over identity.
  const reloaded = await loaded({}, [path.join(root, "other"), workspace]);
  expect(reloaded.entry(key("a.ts"))?.path).toBe(fsPath("a.ts"));
});

test("a removed workspace folder does not hand its baselines to another", async () => {
  const other = path.join(root, "other");
  const store = new BaselineStore(root);
  store.setRoots([workspace, other]);
  await store.load();
  await store.setText(fsPath("a.ts"), "from the first folder\n");
  await store.setText(path.join(other, "b.ts"), "from the second folder\n");
  await store.flush();

  // Only the second folder is still open. Handing it the first folder's entries would diff one
  // project against another project's baseline.
  const reloaded = await loaded({}, [other]);

  expect(reloaded.size).toBe(1);
  expect(reloaded.entry(normalizeKey(path.join(other, "b.ts")))?.path).toBe(
    path.join(other, "b.ts"),
  );
  // Nothing took its place, so there is nothing to baseline either.
  expect(reloaded.arrivedRoots).toEqual([]);
});

test("a dropped folder is off the disk index before its blobs are collected", async () => {
  const other = path.join(root, "other");
  const store = new BaselineStore(root);
  store.setRoots([workspace, other]);
  await store.load();
  await store.setText(fsPath("a.ts"), "from the first folder\n");
  await store.setText(path.join(other, "b.ts"), "from the second folder\n");
  await store.flush();

  // A session that changes nothing: without the rewrite on load, the index would still name the
  // closed folder while collection reclaims the blobs its entries point at.
  const reloaded = await loaded({}, [other]);
  await reloaded.collectGarbage();

  expect(await readIndex()).toMatchObject({ roots: [other] });
  expect((await readIndex()).files).toHaveLength(1);

  // Reopening the folder must find a clean slate rather than a baseline whose blob is gone.
  const reopened = await loaded({}, [workspace, other]);
  expect(reopened.has(key("a.ts"))).toBe(false);
  expect(reopened.arrivedRoots).toEqual([workspace]);
});

test("a folder closed during a session drops its baselines instead of turning absolute", async () => {
  const other = path.join(root, "other");
  const store = new BaselineStore(root);
  store.setRoots([workspace, other]);
  await store.load();
  await store.setText(fsPath("a.ts"), "from the first folder\n");
  await store.setText(path.join(other, "b.ts"), "from the second folder\n");
  await store.flush();

  store.setRoots([other]);
  await store.flush();

  expect(store.has(key("a.ts"))).toBe(false);
  expect((await readIndex()).files).toEqual([
    { root: 0, path: "b.ts", kind: "text", blob: anyBlob },
  ]);

  // Stored absolute, the entry would come back here and hand the reopened folder a baseline from
  // before it was closed, hiding everything that changed while it was gone.
  const reopened = await loaded({}, [workspace, other]);
  expect(reopened.has(key("a.ts"))).toBe(false);
  expect(reopened.arrivedRoots).toEqual([workspace]);
});

test("a window reporting no folders at all leaves the baselines untouched", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");

  store.setRoots([]);
  await store.flush();

  expect(store.has(key("a.ts"))).toBe(true);
  // Storing the path absolute would be just as lossy as dropping the entry: the folder would be
  // reported as arrived on the next load while its baseline was still there to be handed back.
  expect((await readIndex()).files).toEqual([
    { root: 0, path: "a.ts", kind: "text", blob: anyBlob },
  ]);
  expect((await loaded()).arrivedRoots).toEqual([]);
});

test("an arrived folder with nothing in it is still recorded as known", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  // Nothing to baseline under the newcomer, so only the rewrite on load can record it. Left off
  // the index, it would look new again next time and swallow whatever appeared in it meanwhile.
  const empty = path.join(root, "empty");
  const reloaded = await loaded({}, [workspace, empty]);

  expect(reloaded.arrivedRoots).toEqual([empty]);
  expect(await readIndex()).toMatchObject({ roots: [workspace, empty] });
  expect((await loaded({}, [workspace, empty])).arrivedRoots).toEqual([]);
});

test("swapping one folder of a multi-root workspace does not inherit its baselines", async () => {
  const other = path.join(root, "other");
  const store = new BaselineStore(root);
  store.setRoots([workspace, other]);
  await store.load();
  await store.setText(fsPath("a.ts"), "from the first folder\n");
  await store.setText(path.join(other, "b.ts"), "from the second folder\n");
  await store.flush();

  // One folder left, one arrived. That is indistinguishable from a rename, so neither may win.
  const replacement = path.join(root, "replacement");
  const reloaded = await loaded({}, [replacement, other]);

  expect(reloaded.size).toBe(1);
  expect(reloaded.entry(normalizeKey(path.join(replacement, "a.ts")))).toBeUndefined();
  // The folder that stayed keeps its baselines; only the newcomer needs one.
  expect(reloaded.arrivedRoots).toEqual([replacement]);
});

test("an entry whose relative path escapes its root is dropped", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  const index = await readIndex();
  const files = [{ root: 0, path: "../../escape.ts", kind: "text", blob: blobOf(store, "a.ts") }];
  await fs.writeFile(path.join(root, "index.json"), JSON.stringify({ ...index, files }), "utf8");

  expect((await loaded()).size).toBe(0);
});

test("an entry with an unusable root is dropped rather than resolved relatively", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  const index = await readIndex();
  await fs.writeFile(
    path.join(root, "index.json"),
    JSON.stringify({ ...index, roots: [] }),
    "utf8",
  );

  const onError = vi.fn<(message: string, error: unknown) => void>();
  expect((await loaded({ onError }, [])).size).toBe(0);
  expect(onError).toHaveBeenCalled();
});

test("an index with a non-string root is rejected rather than resolved at a shifted position", async () => {
  const other = path.join(root, "other");
  const store = new BaselineStore(root);
  store.setRoots([workspace, other]);
  await store.load();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  // Dropping the bad element alone would slide `other` into position 1 and file the entry
  // under the second project instead of discarding it.
  const index = await readIndex();
  const files = [{ root: 1, path: "a.ts", kind: "text", blob: blobOf(store, "a.ts") }];
  await fs.writeFile(
    path.join(root, "index.json"),
    JSON.stringify({ ...index, roots: [workspace, 42, other], files }),
    "utf8",
  );

  const onError = vi.fn<(message: string, error: unknown) => void>();
  const reloaded = await loaded({ onError }, [workspace, other]);

  expect(reloaded.size).toBe(0);
  expect(reloaded.entry(normalizeKey(path.join(other, "a.ts")))).toBeUndefined();
  expect(onError).toHaveBeenCalled();
});

test("an entry with a malformed blob hash is dropped", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  const index = await readIndex();
  const files = [{ root: 0, path: "a.ts", kind: "text", blob: "../../escape" }];
  await fs.writeFile(path.join(root, "index.json"), JSON.stringify({ ...index, files }), "utf8");

  expect((await loaded()).size).toBe(0);
});

test("an index that is not valid JSON is discarded instead of failing the load", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  store.markInitialized();
  await store.flush();

  await fs.writeFile(path.join(root, "index.json"), '{"version": 1, "files": [', "utf8");

  const onError = vi.fn<(message: string, error: unknown) => void>();
  const reloaded = await loaded({ onError });

  // Staying uninitialized is what sends the model back to a full capture.
  expect(reloaded.size).toBe(0);
  expect(reloaded.initialized).toBe(false);
  expect(onError).toHaveBeenCalled();
});

test("an index written by another format version is discarded", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  store.markInitialized();
  await store.flush();

  const index = await readIndex();
  await fs.writeFile(
    path.join(root, "index.json"),
    JSON.stringify({ ...index, version: 99 }),
    "utf8",
  );

  const onError = vi.fn<(message: string, error: unknown) => void>();
  const reloaded = await loaded({ onError });

  expect(reloaded.size).toBe(0);
  expect(reloaded.initialized).toBe(false);
  expect(onError).toHaveBeenCalled();
});

test("a path outside every root is stored absolute", async () => {
  const store = await loaded();
  const outside = path.join(root, "elsewhere", "a.ts");
  await store.setText(outside, "one\n");
  await store.flush();

  expect((await readIndex()).files).toEqual([{ path: outside, kind: "text", blob: anyBlob }]);
});

test("a clean stat is only recorded when proven and is dropped on rewrite", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");

  const fresh = store.entry(key("a.ts"));
  expect(fresh?.kind === "text" && fresh.clean).toBeUndefined();
  expect(fresh && matchesDisk(fresh, stat(4, 100))).toBe(false);

  store.markClean(key("a.ts"), stat(4, 100));
  const clean = store.entry(key("a.ts"));
  expect(clean && matchesDisk(clean, stat(4, 100))).toBe(true);
  expect(clean && matchesDisk(clean, stat(4, 200))).toBe(false);

  // A rebased or partially accepted baseline no longer matches the file on disk.
  await store.setText(fsPath("a.ts"), "one\ntwo\n");
  const rewritten = store.entry(key("a.ts"));
  expect(rewritten && matchesDisk(rewritten, stat(4, 100))).toBe(false);
});

test("a clean stat survives a reload", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  store.markClean(key("a.ts"), stat(4, 100));
  await store.flush();

  const entry = (await loaded()).entry(key("a.ts"));
  expect(entry && matchesDisk(entry, stat(4, 100))).toBe(true);
});

test("a lost blob reads as unreadable rather than as an absent baseline", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  // A fresh store has an empty cache, so the read has to go to the missing blob.
  await fs.rm(path.join(root, "blobs"), { recursive: true, force: true });

  expect(await (await loaded()).readBaseline(key("a.ts"))).toEqual({ kind: "unreadable" });
});

test("a blob that is no longer valid gzip reads as unreadable", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  // Decompression fails outright here. The sibling case, where the bytes decompress but hash to
  // something else, is what the repair test further down starts from.
  const blob = must(blobOf(store, "a.ts"), "the blob the baseline points at");
  await fs.writeFile(path.join(root, "blobs", blob.slice(0, 2), `${blob.slice(2)}.gz`), "junk");

  expect(await (await loaded()).readBaseline(key("a.ts"))).toEqual({ kind: "unreadable" });
});

test("the cache stays within its budget and still serves correct text", async () => {
  const store = await loaded({ cacheBudget: 64 });
  await store.setText(fsPath("a.ts"), "a".repeat(200));
  await store.setText(fsPath("b.ts"), "b".repeat(200));

  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "a".repeat(200),
    hadBom: false,
  });
  expect(await store.readBaseline(key("b.ts"))).toEqual({
    kind: "text",
    text: "b".repeat(200),
    hadBom: false,
  });
});

test("an evicted entry falls back to its blob instead of going missing", async () => {
  const store = await loaded({ cacheBudget: 1 });
  await store.setText(fsPath("a.ts"), "one\n");
  await store.setText(fsPath("b.ts"), "two\n");

  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: false,
  });
});

test("persistence resumes after a failed index write", async () => {
  const onError = vi.fn<(message: string, error: unknown) => void>();
  const store = await loaded({ onError });

  // Renaming the temp file onto a non-empty directory fails on every platform.
  await fs.mkdir(path.join(root, "index.json"), { recursive: true });
  await fs.writeFile(path.join(root, "index.json", "blocker"), "x");

  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();
  expect(onError).toHaveBeenCalled();

  await fs.rm(path.join(root, "index.json"), { recursive: true, force: true });
  await store.setText(fsPath("b.ts"), "two\n");
  await store.flush();

  expect((await loaded()).size).toBe(2);
});

test("a flush that only waits on another write reports that write's failure", async () => {
  const onError = vi.fn<(message: string, error: unknown) => void>();
  const store = await loaded({ onError });

  await fs.mkdir(path.join(root, "index.json"), { recursive: true });
  await fs.writeFile(path.join(root, "index.json", "blocker"), "x");

  await store.setText(fsPath("a.ts"), "one\n");
  const persisting = store.flush();
  // Nothing is dirty any more, so this call can do nothing but wait on the write already running.
  const waiting = store.flush();

  expect(await persisting).toBe(false);
  expect(await waiting).toBe(false);
});

test("collection is skipped while another caller's index write is failing", async () => {
  const onError = vi.fn<(message: string, error: unknown) => void>();
  const store = await loaded({ onError });
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();
  await ageBlobs(blobsRoot());

  // The blob is unreferenced in memory but the index that still names it cannot be replaced.
  store.delete(key("a.ts"));
  await fs.rm(path.join(root, "index.json"), { force: true });
  await fs.mkdir(path.join(root, "index.json", "blocker"), { recursive: true });

  const persisting = store.flush();
  const collecting = store.collectGarbage();
  await Promise.all([persisting, collecting]);

  expect(await blobFiles(blobsRoot())).toHaveLength(1);
});

test("accepting a file repairs a blob a read proved corrupt", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();

  const blob = must(blobOf(store, "a.ts"), "the blob the baseline points at");
  const target = path.join(root, "blobs", blob.slice(0, 2), `${blob.slice(2)}.gz`);
  await fs.writeFile(target, gzipSync(Buffer.from("tampered\n", "utf8")));

  const reopened = await loaded();
  expect(await reopened.readBaseline(key("a.ts"))).toEqual({ kind: "unreadable" });

  // Accepting stores the same content, so the hash matches the blob that is already there.
  await reopened.setText(fsPath("a.ts"), "one\n");
  await reopened.flush();

  expect(await (await loaded()).readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: false,
  });
});

test("garbage collection keeps referenced blobs and drops the rest", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "keep\n");
  await store.setText(fsPath("b.ts"), "drop\n");
  store.delete(key("b.ts"));
  await store.flush();
  await ageBlobs(blobsRoot());
  await store.collectGarbage();

  expect(await blobFiles(blobsRoot())).toHaveLength(1);
  expect(await (await loaded()).readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "keep\n",
    hadBom: false,
  });
});

test("garbage collection removes temp files and stale layouts from a bucket", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "keep\n");
  await store.flush();

  const kept = must((await blobFiles(blobsRoot()))[0], "the blob that is still referenced");
  const bucket = path.dirname(kept);
  await fs.writeFile(path.join(bucket, "abandoned.gz.4242.1.tmp"), "x");
  await fs.mkdir(path.join(bucket, "old-layout"), { recursive: true });
  await fs.writeFile(path.join(bucket, "old-layout", "blob"), "x");
  await ageBlobs(blobsRoot());
  await fs.utimes(path.join(bucket, "abandoned.gz.4242.1.tmp"), new Date(0), new Date(0));
  await fs.utimes(path.join(bucket, "old-layout"), new Date(0), new Date(0));
  await store.collectGarbage();

  expect(await fs.readdir(bucket)).toEqual([path.basename(kept)]);
});

test("garbage collection removes an index write a crash abandoned", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "keep\n");
  await store.flush();

  // Named as `writeFileAtomic` names them, but by a process that never reached the rename.
  const abandoned = path.join(root, "index.json.4242.1.tmp");
  await fs.writeFile(abandoned, "{}", "utf8");
  await fs.utimes(abandoned, new Date(0), new Date(0));
  await store.collectGarbage();

  await expect(fs.access(abandoned)).rejects.toThrow(/ENOENT/);
  expect((await readIndex()).files).toHaveLength(1);
});

test("a temp file young enough to belong to a write in flight is spared", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "keep\n");
  await store.flush();

  const inFlight = path.join(root, "index.json.4242.1.tmp");
  await fs.writeFile(inFlight, "{}", "utf8");
  await store.collectGarbage();

  await expect(fs.access(inFlight)).resolves.toBeUndefined();
});

test("collections queue instead of overlapping", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "keep\n");
  await store.flush();
  await ageBlobs(blobsRoot());

  // Held at the flush the sweep opens with, so the second call has every chance to overtake it.
  const held = deferred();
  const flush = store.flush.bind(store);
  vi.spyOn(store, "flush").mockImplementationOnce(async () => {
    await held.promise;
    return flush();
  });

  const finished: string[] = [];
  const first = store.collectGarbage().then(() => finished.push("first"));
  const second = store.collectGarbage().then(() => finished.push("second"));
  held.resolve();
  await Promise.all([first, second]);

  expect(finished).toEqual(["first", "second"]);
});

test("collection keeps a blob only the index on disk still names", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n");
  await store.flush();
  await ageBlobs(blobsRoot());

  // The sweep opens with a flush. Replacing the baseline as that flush returns leaves the document
  // on disk naming the old blob while memory names the new one, which is what a crash would find.
  const flush = store.flush.bind(store);
  vi.spyOn(store, "flush").mockImplementationOnce(async () => {
    const persisted = await flush();
    await store.setText(fsPath("a.ts"), "two\n");
    return persisted;
  });

  await store.collectGarbage();

  expect(await blobFiles(blobsRoot())).toHaveLength(2);
  expect(await (await loaded()).readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: false,
  });
});

test("garbage collection spares a blob written alongside it", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "fresh\n");
  store.delete(key("a.ts"));
  await store.collectGarbage();

  // Unreferenced, but too young to be distinguished from a write still in flight.
  expect(await blobFiles(blobsRoot())).toHaveLength(1);
});

test("the byte order mark stays out of the text but survives in the blob", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n", true);
  await store.flush();

  expect(await (await loaded()).readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: true,
  });
});

test("a rebased baseline keeps the byte order mark", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n", true);

  const first = await store.readBaseline(key("a.ts"));
  expect(first.kind).toBe("text");
  if (first.kind !== "text") {
    return;
  }
  // Mirrors the rebase path, which round-trips the baseline through splitLines/join.
  await store.setText(fsPath("a.ts"), `${first.text}two\n`, first.hadBom);

  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: true,
  });
});

test("files that differ only by a byte order mark get different blobs", async () => {
  const store = await loaded();
  await store.setText(fsPath("a.ts"), "one\n", true);
  await store.setText(fsPath("b.ts"), "one\n", false);

  expect(blobOf(store, "a.ts")).not.toBe(blobOf(store, "b.ts"));
});

test("parallel baselines for identical files all land, sharing one blob", async () => {
  const store = await loaded();
  const text = "identical stub\n".repeat(20);
  const names = Array.from({ length: 32 }, (_, index) => `stub${index}.ts`);

  // Different files, one blob between them: the per-file queues run these concurrently, and an
  // unshared blob write loses whichever callers lose the race for its path.
  await Promise.all(names.map((name) => store.setText(fsPath(name), text)));

  expect(store.size).toBe(names.length);
  const blobs = new Set(names.map((name) => blobOf(store, name)));
  expect(blobs.size).toBe(1);
  expect(blobs.has(undefined)).toBe(false);
  const baselines = await Promise.all(names.map((name) => store.readBaseline(key(name))));
  expect(baselines).toEqual(names.map(() => ({ kind: "text", text, hadBom: false })));

  // Proven off disk as well, not just from the store that wrote it.
  await store.flush();
  const reloaded = await loaded();
  expect(await reloaded.readBaseline(key("stub0.ts"))).toEqual({
    kind: "text",
    text,
    hadBom: false,
  });
});
