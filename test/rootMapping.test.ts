import * as path from "node:path";
import { expect, test } from "vitest";
import { mapRoots } from "../src/storage/rootMapping";

const at = (...segments: string[]): string => path.resolve(...segments);

test("folders that did not move map onto themselves and none look new", () => {
  const roots = [at("work", "app"), at("work", "docs")];
  expect(mapRoots(roots, roots)).toEqual({ mapped: roots, arrived: [] });
});

test("a folder is recognised by its path, not by its position", () => {
  const stored = [at("work", "app"), at("work", "docs")];
  const current = [at("work", "docs"), at("work", "app")];
  expect(mapRoots(stored, current)).toEqual({
    mapped: [at("work", "app"), at("work", "docs")],
    arrived: [],
  });
});

test("a folder that moved keeps nothing and counts as newly arrived", () => {
  // Same folder name, new parent. Indistinguishable from one project being swapped for another,
  // so the baselines are dropped and the folder is treated as if it had just been opened.
  expect(mapRoots([at("work", "app")], [at("moved", "app")])).toEqual({
    mapped: [undefined],
    arrived: [at("moved", "app")],
  });
});

test("a folder that was closed loses its mapping while the others keep theirs", () => {
  const stored = [at("work", "app"), at("work", "docs")];
  expect(mapRoots(stored, [at("work", "docs")])).toEqual({
    mapped: [undefined, at("work", "docs")],
    arrived: [],
  });
});

test("a folder added beside untouched ones is the only one reported as arrived", () => {
  const stored = [at("work", "app")];
  const current = [at("work", "app"), at("work", "docs")];
  expect(mapRoots(stored, current)).toEqual({
    mapped: [at("work", "app")],
    arrived: [at("work", "docs")],
  });
});

test("one open folder cannot satisfy two identical stored roots", () => {
  const stored = [at("work", "app"), at("work", "app")];
  expect(mapRoots(stored, [at("work", "app")])).toEqual({
    mapped: [at("work", "app"), undefined],
    arrived: [],
  });
});

test.runIf(process.platform === "win32")("a path is matched case-insensitively", () => {
  expect(mapRoots([at("Work", "App")], [at("work", "app")])).toEqual({
    mapped: [at("work", "app")],
    arrived: [],
  });
});

test("nothing maps and nothing arrives when no folder is open", () => {
  expect(mapRoots([at("work", "app")], [])).toEqual({ mapped: [undefined], arrived: [] });
});
