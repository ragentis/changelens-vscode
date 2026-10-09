import { expect, test } from "vitest";
import { computeHunks } from "../src/core/diff";
import { innerChanges } from "../src/core/innerDiff";
import { must } from "./helpers/assert";

/** The one hunk a baseline-to-current edit produces, which is what the inner diff is asked about. */
function hunkOf(baseline: string, current: string) {
  const hunks = computeHunks(baseline.split("\n"), current.split("\n"));
  expect(hunks).toHaveLength(1);
  return must(hunks[0], "the hunk");
}

/** The marked text of each span, which says more in a failure than offsets would. */
function marked(lines: string[], spans: { line: number; start: number; end: number }[]): string[] {
  return spans.map((span) => must(lines[span.line], "the span's line").slice(span.start, span.end));
}

test("a one-word edit in a long line marks only that word on each side", () => {
  const hunk = hunkOf(
    "judged by its size and modification time, which is what Git left there",
    "judged by its size and content hash, which is what Git left there",
  );

  const changes = must(innerChanges(hunk), "inner changes");
  expect(marked(hunk.baseLines, changes.removed)).toEqual(["modification time"]);
  expect(marked(hunk.currLines, changes.added)).toEqual(["content hash"]);
});

test("a rename moves as one word, not as the letters that differ", () => {
  const hunk = hunkOf("const total = computeTotal(items);", "const total = computeSum(items);");

  const changes = must(innerChanges(hunk), "inner changes");
  expect(marked(hunk.baseLines, changes.removed)).toEqual(["computeTotal"]);
  expect(marked(hunk.currLines, changes.added)).toEqual(["computeSum"]);
});

test("words outside ASCII are still whole words", () => {
  const hunk = hunkOf(
    "autor je Marko Krečković iz Beograda",
    "autor je Marko Petrović iz Beograda",
  );

  const changes = must(innerChanges(hunk), "inner changes");
  expect(marked(hunk.baseLines, changes.removed)).toEqual(["Krečković"]);
  expect(marked(hunk.currLines, changes.added)).toEqual(["Petrović"]);
});

test("a short unchanged run between two changes is bridged into one span", () => {
  const hunk = hunkOf(
    "the result is written to config.json before the run",
    "the result is written to settings.yaml before the run",
  );

  const changes = must(innerChanges(hunk), "inner changes");
  // The dot survived, but "config" and "json" each marked on their own would read as two edits.
  expect(marked(hunk.baseLines, changes.removed)).toEqual(["config.json"]);
  expect(marked(hunk.currLines, changes.added)).toEqual(["settings.yaml"]);
});

test("an insertion marks nothing on the side it did not touch", () => {
  const hunk = hunkOf("call(first, second)", "call(first, second, third)");

  const changes = must(innerChanges(hunk), "inner changes");
  expect(changes.removed).toEqual([]);
  expect(marked(hunk.currLines, changes.added)).toEqual([", third"]);
});

test("spans are cut at line breaks and placed on the line they fall on", () => {
  const hunk = hunkOf(
    "first line stays the same here\nsecond line changes one word here",
    "first line stays the same here\nsecond line changes one letter here\nplus one",
  );

  // The hunk starts at the second line, so its lines are counted from there.
  const changes = must(innerChanges(hunk), "inner changes");
  expect(changes.removed).toEqual([{ line: 0, start: 24, end: 28 }]);
  expect(marked(hunk.currLines, changes.added)).toEqual(["letter", "plus one"]);
  expect(changes.added.map((span) => span.line)).toEqual([0, 1]);
});

test("a line rewritten from scratch is left to the whole-line colour", () => {
  const hunk = hunkOf("return items.length;", "throw new Error(message);");

  // Too little stayed in place: marking every differing word would just be noise over noise.
  expect(innerChanges(hunk)).toBeNull();
});

test("blanks do not count as text kept in place", () => {
  const hunk = hunkOf("        return foo;", "        throw bar;");

  expect(innerChanges(hunk)).toBeNull();
});

test("only a replacement has two sides to compare", () => {
  expect(innerChanges(hunkOf("a\nb", "a\nnew\nb"))).toBeNull();
  expect(innerChanges(hunkOf("a\nb\nc", "a\nc"))).toBeNull();
});

test("a side too long to tokenise on every repaint is skipped", () => {
  const long = "word ".repeat(2_500);
  const hunk = hunkOf(`${long}end`, `${long}END`);

  expect(innerChanges(hunk)).toBeNull();
});
