import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeKey } from "../core/paths";
import { git, resolveGitPath } from "./git";

/** Where HEAD stood the last time ChangeLens looked at a folder. */
export interface GitHead {
  sha: string;
  /** The branch HEAD points at, empty while detached. */
  ref: string;
}

/** What Git did since that observation. */
export type GitMovement =
  /** No Git, no repository, or no commit yet: there is nothing to compare against. */
  | { kind: "unavailable" }
  | { kind: "still"; head: GitHead }
  /** Commits only. They move HEAD without touching a single file in the working tree. */
  | { kind: "commit"; head: GitHead }
  /** Git rewrote the working tree; the ranges are the movements that did it. */
  | { kind: "rewrite"; head: GitHead; ranges: CommitRange[] }
  /** HEAD moved, but no reflog entry says how. */
  | { kind: "unknown"; head: GitHead; branchSwitch: boolean };

/** Two commits whose difference is what one Git operation wrote into the working tree. */
export interface CommitRange {
  from: string;
  to: string;
}

interface ReflogEntry {
  from: string;
  to: string;
  message: string;
}

const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The reflog subjects Git writes when only HEAD moves. A merge or cherry-pick that stopped on a
 * conflict is deliberately absent: it is committed as `commit (merge)`, and the files it left in
 * the working tree were written by Git, not by whoever committed them.
 */
const HEAD_ONLY_SUBJECTS = ["commit:", "commit (amend):", "commit (initial):"];

async function readHead(folder: string): Promise<GitHead | undefined> {
  const sha = (await git(folder, ["rev-parse", "HEAD"]))?.trim();
  if (sha === undefined || !SHA.test(sha)) {
    return undefined;
  }
  // Quiet, because a detached HEAD is an answer rather than a failure.
  const ref = (await git(folder, ["symbolic-ref", "--quiet", "HEAD"]))?.trim() ?? "";
  return { sha, ref };
}

function parseReflog(raw: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of raw.split("\n")) {
    // `<old> <new> <who> <when>\t<subject>`, and the identity before the tab may contain spaces.
    const tab = line.indexOf("\t");
    const [from, to] = line.slice(0, tab < 0 ? undefined : tab).split(" ");
    if (tab > 0 && from !== undefined && to !== undefined && SHA.test(from) && SHA.test(to)) {
      entries.push({ from, to, message: line.slice(tab + 1) });
    }
  }
  return entries;
}

/**
 * The movements recorded since `from`. Absent when the reflog is unreadable — it is off in bare
 * repositories and can be switched off with `core.logAllRefUpdates` — or when it was expired past
 * the commit ChangeLens remembers, leaving nothing that describes how HEAD reached where it is.
 */
async function reflogSince(folder: string, from: string): Promise<ReflogEntry[] | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(await resolveGitPath(folder, "logs/HEAD"), "utf8");
  } catch {
    return undefined;
  }

  const entries = parseReflog(raw);
  const start = entries.findLastIndex((entry) => entry.from === from);
  return start < 0 ? undefined : entries.slice(start);
}

export async function describeMovement(
  folder: string,
  previous: GitHead | undefined,
): Promise<GitMovement> {
  const head = await readHead(folder);
  if (!head) {
    return { kind: "unavailable" };
  }
  // Switching to a branch that points at the same commit rewrites nothing, so it is not a movement.
  if (!previous || previous.sha === head.sha) {
    return { kind: "still", head };
  }

  const entries = await reflogSince(folder, previous.sha);
  if (!entries) {
    return { kind: "unknown", head, branchSwitch: previous.ref !== head.ref };
  }

  const ranges = rewriteRanges(entries);
  return ranges.length === 0 ? { kind: "commit", head } : { kind: "rewrite", head, ranges };
}

function movesHeadOnly(message: string): boolean {
  return HEAD_ONLY_SUBJECTS.some((subject) => message.startsWith(subject));
}

/**
 * The movements that wrote into the working tree, with the commits between them left out. Taking
 * one range from the whole sequence instead would attribute a commit made along the way to Git,
 * and a commit is exactly what ChangeLens still has to show as pending.
 */
function rewriteRanges(entries: readonly ReflogEntry[]): CommitRange[] {
  const ranges: CommitRange[] = [];
  let open: CommitRange | undefined;

  for (const entry of entries) {
    if (movesHeadOnly(entry.message)) {
      open = undefined;
    } else if (open) {
      open.to = entry.to;
    } else {
      open = { from: entry.from, to: entry.to };
      ranges.push(open);
    }
  }

  // Creating a branch is recorded as a checkout that stays on the same commit and writes nothing.
  return ranges.filter((range) => range.from !== range.to);
}

/**
 * Every path Git reports as differing from HEAD, including the ones it does not track, keyed the
 * way the rest of the extension keys a file. Git answers with repository-relative paths whose
 * separator is always `/`, which on POSIX is not enough to tell a separator from a file name
 * containing a backslash, so they are resolved against the root before being compared at all.
 */
async function dirtyKeys(folder: string, root: string): Promise<Set<string> | undefined> {
  const status = await git(folder, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  if (status === undefined) {
    return undefined;
  }

  const dirty = new Set<string>();
  for (const record of status.split("\0")) {
    // Each record is a two-letter status, a space, and the path.
    if (record.length > 3) {
      dirty.add(normalizeKey(path.resolve(root, record.slice(3))));
    }
  }
  return dirty;
}

/** The files Git rewrote between the commits of each range, as absolute paths. */
export async function changedPaths(
  folder: string,
  ranges: readonly CommitRange[],
): Promise<string[]> {
  const root = (await git(folder, ["rev-parse", "--show-toplevel"]))?.trim();
  if (root === undefined) {
    return [];
  }

  const changed = new Set<string>();
  for (const range of ranges) {
    // Renames off, so a moved file is reported as both paths instead of one. Paths stay relative
    // to the repository root even where `diff.relative` is configured.
    const diff = await git(folder, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-relative",
      range.from,
      range.to,
    ]);
    // A range Git can no longer resolve, because the commit was collected, only means fewer files
    // are adopted. Leaving one pending is recoverable; adopting one that was not Git's is not.
    for (const relative of diff?.split("\0") ?? []) {
      if (relative !== "") {
        changed.add(relative);
      }
    }
  }

  return [...changed].map((relative) => path.resolve(root, relative));
}

/**
 * The subset of `paths` whose working-tree content still matches HEAD, which is what establishes
 * that Git wrote what is there now. A write landing before this check — an agent's, or a
 * half-finished conflict resolution — leaves the file dirty and drops it from the answer.
 *
 * Absent when Git could not answer at all, which is not the same as owning nothing: the caller
 * leaves the movement unrecorded so a later one tries again.
 */
export async function pathsMatchingHead(
  folder: string,
  paths: readonly string[],
): Promise<string[] | undefined> {
  const root = (await git(folder, ["rev-parse", "--show-toplevel"]))?.trim();
  if (root === undefined) {
    return undefined;
  }
  if (paths.length === 0) {
    return [];
  }

  const dirty = await dirtyKeys(folder, root);
  return dirty && paths.filter((target) => !dirty.has(normalizeKey(target)));
}
