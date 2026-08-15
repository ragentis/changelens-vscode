import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isInside } from "../src/core/paths";
import { resolveGitHead } from "../src/tracking/gitHead";

/**
 * Run against real Git rather than a stub: the whole point of asking `rev-parse` is that layouts
 * exist where `<folder>/.git/HEAD` is the wrong file, and only Git knows where they put it.
 */

let root: string;

beforeEach(async () => {
  // Git canonicalizes temp aliases such as macOS `/var` and Windows 8.3 path segments.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "changelens-githead-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Identity is passed per command so the test never depends on the machine's Git configuration. */
function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=ChangeLens Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, stdio: "pipe", windowsHide: true },
  );
}

async function repository(name: string): Promise<string> {
  const folder = path.join(root, name);
  await fs.mkdir(folder, { recursive: true });
  git(folder, "-c", "init.defaultBranch=main", "init");
  git(folder, "commit", "--allow-empty", "-m", "root commit");
  return folder;
}

test("a repository root resolves to its own HEAD", async () => {
  const repo = await repository("app");

  // Git answers `.git/HEAD` relative to the folder, so an unresolved answer would not be a path
  // anything could watch.
  expect(await resolveGitHead(repo)).toBe(path.join(repo, ".git", "HEAD"));
});

test("a folder inside a repository resolves to the repository's HEAD, not its own", async () => {
  const repo = await repository("app");
  const nested = path.join(repo, "packages", "web");
  await fs.mkdir(nested, { recursive: true });

  // Opening a subfolder as the workspace root is ordinary; `<folder>/.git/HEAD` does not exist
  // here, so watching it would miss every branch switch.
  expect(await resolveGitHead(nested)).toBe(path.join(repo, ".git", "HEAD"));
});

test("a linked worktree resolves to the HEAD outside the folder that governs it", async () => {
  const repo = await repository("app");
  const linked = path.join(root, "feature");
  git(repo, "worktree", "add", "-b", "feature", linked);

  const head = await resolveGitHead(linked);

  // A worktree has a `.git` file, not a directory, so the naive layout names nothing at all. The
  // real HEAD lives under the main repository, which is why the watcher builds a pattern from the
  // resolved path rather than from the workspace folder.
  expect(head).toBe(path.join(repo, ".git", "worktrees", "feature", "HEAD"));
  expect(isInside(linked, head)).toBe(false);
});

test("a submodule resolves to the HEAD the parent repository keeps for it", async () => {
  const parent = await repository("parent");
  await repository("child");
  // `protocol.file.allow` is off by default since CVE-2022-39253; the source here is a sibling
  // directory, not a remote.
  git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "../child", "vendor/child");

  // A submodule's `.git` is also a file pointing into the parent's `modules/` directory.
  expect(await resolveGitHead(path.join(parent, "vendor", "child"))).toBe(
    path.join(parent, ".git", "modules", "vendor", "child", "HEAD"),
  );
});

test("a folder that is not a repository falls back to the simple layout", async () => {
  const plain = path.join(root, "plain");
  await fs.mkdir(plain, { recursive: true });

  // Nothing to watch yet, but `git init` later creates exactly this file, so the watcher's pattern
  // still fires when the folder becomes a repository.
  expect(await resolveGitHead(plain)).toBe(path.join(plain, ".git", "HEAD"));
});

test("a folder Git cannot even be run in falls back rather than failing", async () => {
  // Spawning with a missing cwd fails the way an unavailable Git would: no answer, an exception,
  // and a watcher that still has to be given some path.
  const missing = path.join(root, "gone");

  await expect(resolveGitHead(missing)).resolves.toBe(path.join(missing, ".git", "HEAD"));
});
