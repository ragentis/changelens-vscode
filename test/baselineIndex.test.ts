import * as path from "node:path";
import { expect, test } from "vitest";
import type { BaselineEntry } from "../src/storage/baselineEntry";
import { INDEX_VERSION, parseIndex, serializeIndex } from "../src/storage/baselineIndex";

const workspace = path.resolve("/work/project");
const blob = "0".repeat(32);

function index(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: INDEX_VERSION,
    initialized: true,
    roots: [workspace],
    files: [{ root: 0, path: "a.ts", kind: "text", blob }],
    ...overrides,
  };
}

/** Parses an index holding exactly one file, whatever that file is. */
function parseOne(file: unknown): ReturnType<typeof parseIndex> {
  return parseIndex(index({ files: [file] }), [workspace]);
}

test("an index written by another format version is not parsed", () => {
  // Rejection is the migration path: the store recaptures rather than reading a shape it does
  // not understand.
  expect(parseIndex(index({ version: INDEX_VERSION + 1 }), [workspace])).toBeUndefined();
  expect(parseIndex(index({ version: "1" }), [workspace])).toBeUndefined();
});

test("a document that is not an index is not parsed", () => {
  expect(parseIndex(null, [workspace])).toBeUndefined();
  expect(parseIndex("{}", [workspace])).toBeUndefined();
  expect(parseIndex([], [workspace])).toBeUndefined();
});

test("an index missing any part of its shape is not parsed", () => {
  expect(parseIndex(index({ initialized: "yes" }), [workspace])).toBeUndefined();
  expect(parseIndex(index({ initialized: undefined }), [workspace])).toBeUndefined();
  expect(parseIndex(index({ roots: workspace }), [workspace])).toBeUndefined();
  expect(parseIndex(index({ files: {} }), [workspace])).toBeUndefined();
});

test("an opaque entry with an unusable stat is dropped", () => {
  const opaque = (stat: unknown): unknown => ({
    root: 0,
    path: "logo.png",
    kind: "opaque",
    reason: "binary",
    stat,
  });

  for (const stat of [
    undefined,
    { size: 1 },
    { mtimeMs: 1 },
    { size: "1", mtimeMs: 1 },
    { size: -1, mtimeMs: 1 },
    { size: 1, mtimeMs: -1 },
    { size: Number.NaN, mtimeMs: 1 },
    { size: 1, mtimeMs: Number.POSITIVE_INFINITY },
  ]) {
    expect(parseOne(opaque(stat))).toMatchObject({ entries: [], skipped: 1 });
  }
});

test("an opaque entry with an unknown reason is dropped", () => {
  const stat = { size: 1, mtimeMs: 1 };
  expect(
    parseOne({ root: 0, path: "logo.png", kind: "opaque", reason: "unwanted", stat }),
  ).toMatchObject({ entries: [], skipped: 1 });
});

test("an unusable clean stat costs the hint rather than the baseline", () => {
  const parsed = parseOne({ root: 0, path: "a.ts", kind: "text", blob, clean: { size: -1 } });

  expect(parsed?.skipped).toBe(0);
  expect(parsed?.entries).toEqual([{ path: path.join(workspace, "a.ts"), kind: "text", blob }]);
});

test("a serialized index parses back into the entries it was built from", () => {
  const entries: BaselineEntry[] = [
    { path: path.join(workspace, "src", "a.ts"), kind: "text", blob },
    { path: path.join(workspace, "b.ts"), kind: "text", blob, clean: { size: 4, mtimeMs: 9 } },
    {
      path: path.join(workspace, "logo.png"),
      kind: "opaque",
      reason: "binary",
      stat: { size: 42, mtimeMs: 7 },
    },
  ];

  const parsed = parseIndex(serializeIndex(entries, [workspace], true), [workspace]);

  expect(parsed).toEqual({
    initialized: true,
    roots: [workspace],
    entries,
    arrived: [],
    skipped: 0,
    needsRewrite: false,
  });
});
