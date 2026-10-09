import type { Hunk, Op } from "./diff";
import { diffLines } from "./diff";

/**
 * The words a replacement actually changed, so a one-word edit in a long paragraph can be marked
 * inside the line rather than leaving the reader to compare two whole lines by eye.
 */

export interface TextSpan {
  /** Line within the hunk's side, counted from its first removed or added line. */
  line: number;
  start: number;
  end: number;
}

export interface InnerChanges {
  removed: TextSpan[];
  added: TextSpan[];
}

/** Past this length a side is a rewrite or a paste, and the whole lines say enough. */
const MAX_SIDE_LENGTH = 10_000;

/**
 * Below this share of non-blank text kept in place, the two sides are rewrites of each other, and
 * marking every word that differs would only add noise to lines already coloured whole.
 */
const MIN_KEPT_RATIO = 0.5;

/** An unchanged run this short between two changes reads better as part of one change. */
const MAX_BRIDGE_LENGTH = 2;

/** Words, runs of blanks, and single punctuation marks, so a rename moves as one piece. */
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

interface Token {
  text: string;
  start: number;
  end: number;
}

interface Span {
  start: number;
  end: number;
}

export function innerChanges(hunk: Hunk): InnerChanges | null {
  if (hunk.kind !== "replace") {
    return null;
  }
  const base = hunk.baseLines.join("\n");
  const curr = hunk.currLines.join("\n");
  if (base.length > MAX_SIDE_LENGTH || curr.length > MAX_SIDE_LENGTH) {
    return null;
  }

  const baseTokens = tokenize(base);
  const currTokens = tokenize(curr);
  const ops = diffLines(
    baseTokens.map((token) => token.text),
    currTokens.map((token) => token.text),
  );
  if (!keepsEnough(ops, baseTokens, base, curr)) {
    return null;
  }

  const removed: Span[] = [];
  const added: Span[] = [];
  ops.forEach((op, index) => {
    if (op.kind === "equal" && !isBridge(op, index, ops, baseTokens)) {
      return;
    }
    if (op.kind !== "insert") {
      push(removed, spanOf(baseTokens, op.aStart, op.count));
    }
    if (op.kind !== "delete") {
      push(added, spanOf(currTokens, op.bStart, op.count));
    }
  });

  return {
    removed: toLines(removed, hunk.baseLines),
    added: toLines(added, hunk.currLines),
  };
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function keepsEnough(ops: Op[], baseTokens: Token[], base: string, curr: string): boolean {
  let kept = 0;
  for (const op of ops) {
    if (op.kind === "equal") {
      for (let i = op.aStart; i < op.aStart + op.count; i++) {
        kept += nonBlankLength(baseTokens[i]?.text ?? "");
      }
    }
  }
  const longest = Math.max(nonBlankLength(base), nonBlankLength(curr));
  return longest > 0 && kept / longest >= MIN_KEPT_RATIO;
}

function nonBlankLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function isBridge(op: Op, index: number, ops: Op[], tokens: Token[]): boolean {
  if (index === 0 || index === ops.length - 1) {
    return false;
  }
  const { start, end } = spanOf(tokens, op.aStart, op.count);
  return end - start <= MAX_BRIDGE_LENGTH;
}

function spanOf(tokens: Token[], first: number, count: number): Span {
  const start = tokens[first];
  const end = tokens[first + count - 1];
  if (!start || !end) {
    throw new RangeError("Inner diff op is outside its token range.");
  }
  return { start: start.start, end: end.end };
}

function push(spans: Span[], span: Span): void {
  const last = spans[spans.length - 1];
  if (last && last.end === span.start) {
    last.end = span.end;
  } else {
    spans.push(span);
  }
}

/** Cuts spans over the joined text at the line breaks, keeping only the pieces that show. */
function toLines(spans: Span[], lines: string[]): TextSpan[] {
  const result: TextSpan[] = [];
  let line = 0;
  let lineStart = 0;
  for (const span of spans) {
    while (lineStart + (lines[line]?.length ?? 0) < span.start && line < lines.length - 1) {
      lineStart += (lines[line]?.length ?? 0) + 1;
      line++;
    }
    let at = line;
    let atStart = lineStart;
    while (at < lines.length && atStart < span.end) {
      const length = lines[at]?.length ?? 0;
      const start = Math.max(span.start, atStart) - atStart;
      const end = Math.min(span.end, atStart + length) - atStart;
      if (start < end) {
        result.push({ line: at, start, end });
      }
      atStart += length + 1;
      at++;
    }
  }
  return result;
}
