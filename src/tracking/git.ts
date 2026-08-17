import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * The extension's only process boundary: every Git query goes through {@link git}, which is what
 * the bundle audit and SECURITY.md rely on. Arguments are assembled from literals by the callers
 * here and in `gitMovement`, never from workspace content.
 */

const execFileAsync = promisify(execFile);

/**
 * Generous, because `status --untracked-files=all` walks the whole working tree: on a large
 * repository without a filesystem monitor that is seconds of work, and giving up on it early would
 * silently leave a pull unattributed.
 */
const GIT_TIMEOUT_MS = 15_000;
/** A pull that rewrites tens of thousands of files still has to fit into one answer. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Runs Git in `folder`, answering `undefined` for a non-zero exit, a timeout, or no Git at all. */
export async function git(folder: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: folder,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Asks Git where one of its own files lives, because nested roots, worktrees, and submodules may
 * not keep it under `<folder>/.git`. Falls back to that simple layout when Git cannot answer.
 */
export async function resolveGitPath(folder: string, name: string): Promise<string> {
  const resolved = (await git(folder, ["rev-parse", "--git-path", name]))?.trim();
  if (resolved) {
    // Git answers relatively when the folder is the repository root.
    return path.resolve(folder, resolved);
  }
  return path.join(folder, ".git", ...name.split("/"));
}

export function resolveGitHead(folder: string): Promise<string> {
  return resolveGitPath(folder, "HEAD");
}

/** The reflog Git appends to on every HEAD movement, which is the signal a pull raises. */
export function resolveGitReflog(folder: string): Promise<string> {
  return resolveGitPath(folder, "logs/HEAD");
}
