import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;

/**
 * Asks Git for the governing HEAD because nested roots, worktrees, and submodules may not use
 * `<folder>/.git/HEAD`. Falls back to that simple layout when Git cannot answer.
 */
export async function resolveGitHead(folder: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "HEAD"], {
      cwd: folder,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const resolved = stdout.trim();
    if (resolved) {
      // Git answers relatively when the folder is the repository root.
      return path.resolve(folder, resolved);
    }
  } catch {
    // Fall back for non-repositories or unavailable Git.
  }
  return path.join(folder, ".git", "HEAD");
}
