import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isTempFileFor, writeFileAtomic } from "../src/core/files";

// `writeFileAtomic` reaches for the real filesystem, so only the two calls under test are replaced,
// one rejection at a time.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    rename: vi.fn<typeof actual.rename>(actual.rename),
    rm: vi.fn<typeof actual.rm>(actual.rm),
  };
});

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-files-"));
});

afterEach(async () => {
  vi.mocked(fs.rename).mockClear();
  vi.mocked(fs.rm).mockClear();
  await fs.rm(root, { recursive: true, force: true });
});

test("a write replaces the target without leaving a temp file behind", async () => {
  const target = path.join(root, "state.json");
  await fs.writeFile(target, "old");

  await writeFileAtomic(target, "new");

  expect(await fs.readFile(target, "utf8")).toBe("new");
  const leftovers = (await fs.readdir(root)).filter((name) => isTempFileFor(name, "state.json"));
  expect(leftovers).toEqual([]);
});

test("a failed write reports its own error, not the cleanup that follows", async () => {
  const target = path.join(root, "state.json");
  await fs.writeFile(target, "old");
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));
  vi.mocked(fs.rm).mockRejectedValueOnce(new Error("cleanup failed"));

  await expect(writeFileAtomic(target, "new")).rejects.toThrow("rename failed");

  // The point of the temp file: a failed write leaves the previous content in place.
  expect(await fs.readFile(target, "utf8")).toBe("old");
});
