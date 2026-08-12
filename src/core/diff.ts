export type OpKind = "equal" | "delete" | "insert";

export interface Op {
  kind: OpKind;
  /** Line index in the "a" (baseline) sequence where this op starts. */
  aStart: number;
  /** Line index in the "b" (current) sequence where this op starts. */
  bStart: number;
  count: number;
}

export type HunkKind = "add" | "delete" | "replace";

export interface Hunk {
  index: number;
  kind: HunkKind;
  baseStart: number;
  baseLines: string[];
  currStart: number;
  currLines: string[];
}

/** Beyond this edit distance, report the unmatched region as one replacement. */
const MAX_EDIT_DISTANCE = 1500;

function vectorValue(vector: Int32Array, index: number): number {
  const value = vector[index];
  if (value === undefined) {
    throw new RangeError("Diff vector index is outside its allocated range.");
  }
  return value;
}

function traceValue(trace: Int32Array[], index: number): Int32Array {
  const value = trace[index];
  if (!value) {
    throw new RangeError("Diff trace index is outside its recorded range.");
  }
  return value;
}

/**
 * Each trace row stores only `k` in `[-d - 1, d + 1]`; shifting by `d + 1` maps those diagonals to
 * local indexes and halves worst-case retained trace memory from roughly 18 MB to 9 MB.
 */
function traceIndex(k: number, d: number): number {
  return k + d + 1;
}

export function diffLines(a: string[], b: string[]): Op[] {
  let prefix = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = Math.min(a.length, b.length) - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  let mid = myers(midA, midB);
  if (!mid) {
    mid = [];
    if (midA.length) {
      mid.push({ kind: "delete", aStart: 0, bStart: 0, count: midA.length });
    }
    if (midB.length) {
      mid.push({ kind: "insert", aStart: midA.length, bStart: 0, count: midB.length });
    }
  }

  const ops: Op[] = [];
  if (prefix > 0) {
    ops.push({ kind: "equal", aStart: 0, bStart: 0, count: prefix });
  }
  for (const op of mid) {
    ops.push({ ...op, aStart: op.aStart + prefix, bStart: op.bStart + prefix });
  }
  if (suffix > 0) {
    ops.push({
      kind: "equal",
      aStart: a.length - suffix,
      bStart: b.length - suffix,
      count: suffix,
    });
  }
  return ops;
}

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0) {
    return [{ kind: "insert", aStart: 0, bStart: 0, count: m }];
  }
  if (m === 0) {
    return [{ kind: "delete", aStart: 0, bStart: 0, count: n }];
  }

  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = maxD + 1;
  const size = 2 * maxD + 3;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && vectorValue(v, off + k - 1) < vectorValue(v, off + k + 1))) {
        x = vectorValue(v, off + k + 1);
      } else {
        x = vectorValue(v, off + k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m) {
        const aLine = a[x];
        const bLine = b[y];
        if (aLine === undefined || bLine === undefined) {
          throw new RangeError("Diff line index is outside its input range.");
        }
        if (aLine !== bLine) {
          break;
        }
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, d, n, m);
      }
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], lastD: number, n: number, m: number): Op[] {
  const steps: OpKind[] = [];
  let x = n;
  let y = m;

  for (let d = lastD; d > 0; d--) {
    const v = traceValue(trace, d);
    const k = x - y;
    const prevK =
      k === -d ||
      (k !== d && vectorValue(v, traceIndex(k - 1, d)) < vectorValue(v, traceIndex(k + 1, d)))
        ? k + 1
        : k - 1;
    const prevX = vectorValue(v, traceIndex(prevK, d));
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      steps.push("equal");
      x--;
      y--;
    }
    if (x === prevX) {
      steps.push("insert");
      y--;
    } else {
      steps.push("delete");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    steps.push("equal");
    x--;
    y--;
  }

  steps.reverse();

  const ops: Op[] = [];
  let aPos = 0;
  let bPos = 0;
  for (const kind of steps) {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) {
      last.count++;
    } else {
      ops.push({ kind, aStart: aPos, bStart: bPos, count: 1 });
    }
    if (kind === "equal") {
      aPos++;
      bPos++;
    } else if (kind === "delete") {
      aPos++;
    } else {
      bPos++;
    }
  }
  return ops;
}

export function buildHunks(ops: Op[], a: string[], b: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let pending: { baseStart: number; currStart: number; deleted: number; inserted: number } | null =
    null;

  const flush = () => {
    if (!pending) {
      return;
    }
    const baseLines = a.slice(pending.baseStart, pending.baseStart + pending.deleted);
    const currLines = b.slice(pending.currStart, pending.currStart + pending.inserted);
    hunks.push({
      index: hunks.length,
      kind: pending.deleted === 0 ? "add" : pending.inserted === 0 ? "delete" : "replace",
      baseStart: pending.baseStart,
      baseLines,
      currStart: pending.currStart,
      currLines,
    });
    pending = null;
  };

  for (const op of ops) {
    if (op.kind === "equal") {
      flush();
      continue;
    }
    if (!pending) {
      pending = { baseStart: op.aStart, currStart: op.bStart, deleted: 0, inserted: 0 };
    }
    if (op.kind === "delete") {
      pending.deleted += op.count;
    } else {
      pending.inserted += op.count;
    }
  }
  flush();
  return hunks;
}

export function computeHunks(baseline: string[], current: string[]): Hunk[] {
  return buildHunks(diffLines(baseline, current), baseline, current);
}

export function countLines(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    added += hunk.currLines.length;
    removed += hunk.baseLines.length;
  }
  return { added, removed };
}
