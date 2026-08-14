import { expect, test } from "vitest";
import type { Hunk } from "../src/core/diff";
import { computeHunks } from "../src/core/diff";
import { rebaseBaseline } from "../src/core/rebase";
import { buildUnified } from "../src/core/unified";

/**
 * The three stages a pending change passes through: `computeHunks` finds it, `rebaseBaseline`
 * decides how much of it survives an edit the user makes in the editor, and `buildUnified` lays it
 * out for review. They share a file because each stage is only meaningful against the last one's
 * output, and most of these tests assert the pair rather than one call.
 */

const lines = (text: string) => text.split("\n");

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Expected an item at index ${index}.`);
  }
  return item;
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return itemAt(items, 0);
}

// #region finding the hunks

test("detects a pure insertion", () => {
  const hunk = only(computeHunks(lines("a\nb"), lines("a\nnew\nb")));
  expect(hunk.kind).toBe("add");
  expect(hunk.currLines).toEqual(["new"]);
  expect(hunk.currStart).toBe(1);
});

test("detects a deletion at the end of a file", () => {
  const hunk = only(computeHunks(lines("a\nb\nc"), lines("a")));
  expect(hunk.kind).toBe("delete");
  expect(hunk.baseLines).toEqual(["b", "c"]);
  expect(hunk.currStart).toBe(1);
});

test("detects a replacement in the middle", () => {
  const hunk = only(computeHunks(lines("a\nb\nc"), lines("a\nB\nc")));
  expect(hunk.kind).toBe("replace");
  expect(hunk.baseLines).toEqual(["b"]);
  expect(hunk.currLines).toEqual(["B"]);
});

test("separates distant edits into separate hunks", () => {
  const hunks = computeHunks(lines("a\nb\nc\nd\ne"), lines("A\nb\nc\nd\nE"));

  // Two blocks with the untouched middle between them, which is what makes each one separately
  // acceptable. One hunk spanning the lot would force the user to take both or neither.
  expect(hunks.map((hunk) => hunk.currLines)).toEqual([["A"], ["E"]]);
  expect(hunks.map((hunk) => hunk.baseStart)).toEqual([0, 4]);
});

test("identical content produces no hunks", () => {
  expect(computeHunks(lines("a\nb"), lines("a\nb"))).toHaveLength(0);
});

/** Deterministic source, so a failing shape can be reproduced from the seed. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function applyHunks(baseline: string[], hunks: Hunk[]): string[] {
  const result = baseline.slice();
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = itemAt(hunks, i);
    result.splice(hunk.baseStart, hunk.baseLines.length, ...hunk.currLines);
  }
  return result;
}

test("applying every hunk turns the baseline into the current file", () => {
  const random = makeRandom(20260813);
  for (let round = 0; round < 200; round++) {
    const baseline = Array.from({ length: 1 + Math.floor(random() * 60) }, () =>
      String(Math.floor(random() * 8)),
    );
    const current = baseline
      .filter(() => random() > 0.3)
      .flatMap((line) => (random() > 0.8 ? [line, "inserted"] : [line]));

    expect(applyHunks(baseline, computeHunks(baseline, current))).toEqual(current);
  }
});

test("a diff deep enough to fill the trace still reconstructs the current file", () => {
  const baseline = Array.from({ length: 400 }, (_, i) => `baseline ${i}`);
  const current = Array.from({ length: 400 }, (_, i) => `current ${i}`);

  expect(applyHunks(baseline, computeHunks(baseline, current))).toEqual(current);
});

test("a diff past the edit distance limit falls back to one whole-file replacement", () => {
  const baseline = Array.from({ length: 800 }, (_, i) => `baseline ${i}`);
  const current = Array.from({ length: 800 }, (_, i) => `current ${i}`);

  const hunk = only(computeHunks(baseline, current));
  expect(hunk.kind).toBe("replace");
  expect(hunk.baseLines).toEqual(baseline);
  expect(hunk.currLines).toEqual(current);
});

test("accepting a hunk advances only that hunk in the baseline", () => {
  const baseline = lines("a\nb\nc\nd\ne");
  const current = lines("A\nb\nc\nd\nE");
  const hunks = computeHunks(baseline, current);
  expect(hunks).toHaveLength(2);
  const first = itemAt(hunks, 0);

  const advanced = baseline.slice();
  advanced.splice(first.baseStart, first.baseLines.length, ...first.currLines);

  const remaining = only(computeHunks(advanced, current));
  expect(remaining.currLines).toEqual(["E"]);
});

// #endregion

// #region folding an editor edit into the baseline

test("user edits outside a pending hunk are folded into the baseline", () => {
  const baseline = lines("one\ntwo\nthree");
  const prevCurrent = lines("one\ntwo\nAGENT\nthree");
  const newCurrent = lines("one\nTWO EDITED\nAGENT\nthree");

  const rebased = rebaseBaseline(baseline, prevCurrent, newCurrent);

  expect(rebased).toEqual(["one", "TWO EDITED", "three"]);
  const pending = only(computeHunks(rebased, newCurrent));
  expect(pending.currLines).toEqual(["AGENT"]);
});

test("user edits inside a pending hunk stay part of that hunk", () => {
  const baseline = lines("one\ntwo");
  const prevCurrent = lines("one\nAGENT\ntwo");
  const newCurrent = lines("one\nAGENT EDITED\ntwo");

  const rebased = rebaseBaseline(baseline, prevCurrent, newCurrent);

  expect(rebased).toEqual(baseline);
  const pending = only(computeHunks(rebased, newCurrent));
  expect(pending.currLines).toEqual(["AGENT EDITED"]);
});

test("a user edit spanning a pending hunk leaves that hunk pending", () => {
  const baseline = lines("one\ntwo\nthree\nfour\nfive");
  const prevCurrent = lines("one\ntwo\nAGENT\nfour\nfive");
  const newCurrent = lines("one\nEDITED\nEDITED TOO\nEDITED AS WELL\nfive");

  const rebased = rebaseBaseline(baseline, prevCurrent, newCurrent);

  // The edit cannot be separated from the agent's line, so none of it is folded in and the whole
  // span stays up for review rather than half of it being silently accepted.
  expect(rebased).toEqual(baseline);
  const pending = only(computeHunks(rebased, newCurrent));
  expect(pending.kind).toBe("replace");
  expect(pending.baseLines).toEqual(["two", "three", "four"]);
  expect(pending.currLines).toEqual(["EDITED", "EDITED TOO", "EDITED AS WELL"]);
});

test("a user edit next to a pending deletion folds in without absorbing it", () => {
  const baseline = lines("one\nAGENT DELETED\ntwo");
  const prevCurrent = lines("one\ntwo");
  const newCurrent = lines("one\nTWO EDITED");

  const rebased = rebaseBaseline(baseline, prevCurrent, newCurrent);

  expect(rebased).toEqual(["one", "AGENT DELETED", "TWO EDITED"]);
  const pending = only(computeHunks(rebased, newCurrent));
  expect(pending.kind).toBe("delete");
  expect(pending.baseLines).toEqual(["AGENT DELETED"]);
});

test("a user insertion at a pending deletion point folds into the baseline", () => {
  const baseline = lines("one\nAGENT DELETED\ntwo");
  const prevCurrent = lines("one\ntwo");
  const newCurrent = lines("one\nNEW\ntwo");

  const rebased = rebaseBaseline(baseline, prevCurrent, newCurrent);

  expect(rebased).toEqual(["one", "NEW", "AGENT DELETED", "two"]);
  const pending = only(computeHunks(rebased, newCurrent));
  expect(pending.baseLines).toEqual(["AGENT DELETED"]);
});

test("a file without pending changes takes the fast path", () => {
  const baseline = lines("one\ntwo");
  const rebased = rebaseBaseline(baseline, baseline, lines("one\ntwo\nthree"));
  expect(rebased).toEqual(["one", "two", "three"]);
  expect(computeHunks(rebased, lines("one\ntwo\nthree"))).toHaveLength(0);
});

test("undoing an agent line manually clears the hunk", () => {
  const baseline = lines("one\ntwo");
  const current = lines("one\nAGENT\ntwo");
  expect(computeHunks(baseline, current)).toHaveLength(1);

  const rebased = rebaseBaseline(baseline, current, baseline);
  expect(rebased).toEqual(baseline);
  expect(computeHunks(rebased, baseline)).toHaveLength(0);
});

// #endregion

// #region the unified layout

test("unified view keeps deleted lines above their replacement", () => {
  const baseline = lines("one\nold\nthree");
  const current = lines("one\nnew\nthree");
  const hunks = computeHunks(baseline, current);

  const unified = buildUnified(current, hunks);

  expect(unified.lines).toEqual(["one", "old", "new", "three"]);
  expect(unified.hunks).toEqual([
    { index: 0, start: 1, removedStart: 1, removedCount: 1, addedStart: 2, addedCount: 1 },
  ]);
});

test("unified view renders a deletion-only hunk in place", () => {
  const baseline = lines("a\ngone\nb");
  const current = lines("a\nb");
  const unified = buildUnified(current, computeHunks(baseline, current));

  expect(unified.lines).toEqual(["a", "gone", "b"]);
  const hunk = only(unified.hunks);
  expect(hunk.addedCount).toBe(0);
  expect(hunk.removedStart).toBe(1);
});

test("unified view keeps full context around multiple hunks", () => {
  const baseline = lines("a\nb\nc\nd\ne");
  const current = lines("A\nb\nc\nd\nE");
  const unified = buildUnified(current, computeHunks(baseline, current));

  expect(unified.lines).toEqual(["a", "A", "b", "c", "d", "e", "E"]);
  expect(unified.hunks).toHaveLength(2);
});

// #endregion
