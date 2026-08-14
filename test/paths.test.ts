import * as path from "node:path";
import { expect, test } from "vitest";
import { dirPrefix, isInside, normalizeKey } from "../src/core/paths";

const at = (...segments: string[]): string => path.resolve(...segments);

test("a descendant whose name starts with two dots is still inside its root", () => {
  const root = at("workspace-root");
  expect(isInside(root, path.join(root, "..config", "settings.json"))).toBe(true);
});

test("the root itself and paths that escape it are not inside the root", () => {
  const root = at("workspace-root");
  expect(isInside(root, root)).toBe(false);
  expect(isInside(root, path.dirname(root))).toBe(false);
  expect(isInside(root, path.join(path.dirname(root), "other-root", "file.ts"))).toBe(false);
});

test("a detour through a parent directory lands on the same key", () => {
  // Events and settings spell the same file in more than one way, and each spelling ends up as a
  // map key. Two keys for one file would baseline it twice.
  expect(normalizeKey(at("work", "src", "..", "src", "a.ts"))).toBe(
    normalizeKey(at("work", "src", "a.ts")),
  );
});

test.runIf(process.platform === "win32")("case folds where the filesystem folds it", () => {
  // The drive letter is the case that actually varies: VS Code hands back both spellings.
  expect(normalizeKey("C:\\Work\\App\\a.ts")).toBe(normalizeKey("c:\\work\\app\\A.ts"));
});

test.runIf(process.platform !== "win32")("case is kept where the filesystem keeps it", () => {
  // Folding here would merge two genuinely different files into one baseline.
  expect(normalizeKey("/work/App/a.ts")).not.toBe(normalizeKey("/work/app/A.ts"));
});

test("a directory prefix ends in exactly one separator, however it arrived", () => {
  const folder = at("work", "src");
  // A folder event carries either spelling, and the prefix is matched against child keys with
  // `startsWith`, so a doubled or missing separator would match nothing at all.
  expect(dirPrefix(folder)).toBe(normalizeKey(folder) + path.sep);
  expect(dirPrefix(folder + path.sep)).toBe(dirPrefix(folder));
  expect(normalizeKey(path.join(folder, "a.ts")).startsWith(dirPrefix(folder))).toBe(true);
});
