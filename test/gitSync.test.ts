import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { normalizeKey } from "../src/core/paths";
import { changedPaths, pathsMatchingHead } from "../src/tracking/gitMovement";
import { must } from "./helpers/assert";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import {
  BRANCH_CHANGED_PROMPT,
  GitSync,
  KEEP_PENDING,
  RESET_BASELINE,
  resetForBranchSwitch,
} from "../src/tracking/gitSync";
import * as editor from "./helpers/vscode";

/**
 * Run against real Git. What has to be right here is which of Git's own operations rewrite the
 * working tree and which only move HEAD past it, and that distinction lives in Git, not in a stub.
 */

let root: string;
let origin: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;
let gitSync: GitSync;

/** Long enough that two edits to it can be merged without conflicting. */
const APP = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

beforeEach(async () => {
  // Git canonicalizes temp aliases such as macOS `/var` and Windows 8.3 path segments, and the
  // paths it reports have to match the ones the workspace is opened under.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "changelens-gitsync-")));
  origin = path.join(root, "origin");
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
  gitSync = new GitSync(model);
});

afterEach(async () => {
  vi.restoreAllMocks();
  model.dispose();
  await store.flush();
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

function fsPath(name: string, folder = workspace): string {
  return path.join(folder, name);
}

function key(name: string): string {
  return normalizeKey(fsPath(name));
}

async function write(name: string, text: string, folder = workspace): Promise<void> {
  await fs.writeFile(fsPath(name, folder), text, "utf8");
}

async function baseline(name: string): Promise<string | undefined> {
  const stored = await store.readBaseline(key(name));
  return stored.kind === "text" ? stored.text : undefined;
}

/** An upstream repository with one commit, cloned into the folder opened as the workspace. */
async function clonedRepository(): Promise<void> {
  await fs.mkdir(origin, { recursive: true });
  git(origin, "-c", "init.defaultBranch=main", "init");
  // Pinned so the fixture's line endings survive a machine whose global config converts them.
  git(origin, "config", "core.autocrlf", "false");
  await write("app.ts", `${APP.join("\n")}\n`, origin);
  await write("other.ts", "untouched\n", origin);
  git(origin, "add", ".");
  git(origin, "commit", "-m", "first");

  await fs.rm(workspace, { recursive: true, force: true });
  git(root, "clone", "--config", "core.autocrlf=false", origin, workspace);
}

/** Replaces one line of `app.ts` upstream, far from the line an agent is given to rewrite. */
async function upstreamCommit(...files: string[]): Promise<void> {
  for (const name of files) {
    const text = name === "app.ts" ? `${["pulled", ...APP.slice(1)].join("\n")}\n` : "pulled\n";
    await write(name, text, origin);
  }
  git(origin, "add", "-A");
  git(origin, "commit", "-m", "upstream work");
}

function pull(): void {
  git(workspace, "pull", "--no-rebase", "origin", "main");
}

/** A pull Git is expected to stop, which it reports by failing. */
function pullIntoConflict(): void {
  try {
    pull();
  } catch {
    return;
  }
  throw new Error("the pull was expected to conflict");
}

/** Rewrites a file the way an agent does, and lets the model see it. */
async function agentWrote(name: string, text: string): Promise<void> {
  await write(name, text);
  await model.recompute(editor.asUri(editor.Uri.file(fsPath(name))));
}

/** The agent's edit to `app.ts`, which merges cleanly with the upstream one. */
function agentApp(): string {
  return `${[...APP.slice(0, -1), "written by an agent"].join("\n")}\n`;
}

/** What the watcher would report after Git rewrote part of the workspace. */
function gitFinished(): Promise<void> {
  return model.reconcile(false);
}

/** Answers a dialog with the given button, or dismisses it when omitted. */
function userClicks(label?: string): void {
  editor.state.answer = (_message, items) =>
    label !== undefined && items.includes(label) ? label : undefined;
}

/** One pass of what activation and the Git watchers do: look at where HEAD stands now. */
function observe(): Promise<void> {
  return gitSync.sync(workspace);
}

// ── what Git rewrote ───────────────────────────────────────────────────────

test("a pull's writes are folded into the baseline instead of being reviewed", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();

  await upstreamCommit("app.ts");
  pull();
  await gitFinished();
  // Without the sync this is what the user is left looking at: Git's own write, up for review.
  expect(model.get(key("app.ts"))?.status).toBe("modified");

  await observe();

  expect(model.files).toEqual([]);
  expect(await baseline("app.ts")).toBe(`${["pulled", ...APP.slice(1)].join("\n")}\n`);
});

test("a pull leaves changes it did not write pending", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();
  await agentWrote("other.ts", "written by an agent\n");

  await upstreamCommit("app.ts");
  pull();
  await gitFinished();
  await observe();

  // The pull explains `app.ts` and nothing else; the agent's file is still the user's to review.
  expect(model.files.map((file) => file.key)).toEqual([key("other.ts")]);
  expect(await baseline("other.ts")).toBe("untouched\n");
});

test("a file Git deleted in a pull leaves no pending deletion behind", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();

  await fs.rm(fsPath("other.ts", origin));
  git(origin, "add", "-A");
  git(origin, "commit", "-m", "drop other");
  pull();
  await gitFinished();
  await observe();

  expect(model.files).toEqual([]);
  expect(store.has(key("other.ts"))).toBe(false);
});

test("a branch switch is absorbed per file, without asking", async () => {
  await clonedRepository();
  git(workspace, "checkout", "-b", "feature");
  await write("app.ts", "on the feature branch\n");
  git(workspace, "commit", "-am", "feature work");
  // The baseline is captured on the feature branch, so switching away rewrites the file.
  await model.initialize();
  await observe();

  git(workspace, "checkout", "main");
  await gitFinished();
  await observe();

  // The reflog names the files the checkout rewrote, so nothing has to be reset wholesale.
  expect(editor.state.shown).toEqual([]);
  expect(model.files).toEqual([]);
  expect(await baseline("app.ts")).toBe(`${APP.join("\n")}\n`);
});

// ── what Git only moved past ───────────────────────────────────────────────

test("committing an agent's change keeps it pending", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();
  await agentWrote("app.ts", agentApp());

  git(workspace, "commit", "-am", "commit the agent's work");
  await observe();

  // A commit rewrites nothing on disk, and committing is not reviewing.
  expect(model.get(key("app.ts"))?.status).toBe("modified");
  expect(await baseline("app.ts")).toBe(`${APP.join("\n")}\n`);
});

test("committing a file an agent added keeps it pending", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();
  await agentWrote("added.ts", "written by an agent\n");

  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "commit the new file");
  await observe();

  expect(model.get(key("added.ts"))?.status).toBe("added");
});

test("branching before the commit still keeps the agent's change pending", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();
  await agentWrote("app.ts", agentApp());

  // The checkout is recorded in the reflog too, but it stays on the commit it started from.
  git(workspace, "checkout", "-b", "feature");
  git(workspace, "commit", "-am", "commit the agent's work");
  await observe();

  expect(model.get(key("app.ts"))?.status).toBe("modified");
  expect(editor.state.shown).toEqual([]);
});

test("a reset that leaves the working tree alone adopts nothing", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();
  await agentWrote("app.ts", agentApp());
  git(workspace, "commit", "-am", "commit the agent's work");

  // `--soft` moves HEAD back but leaves every file exactly as it is.
  git(workspace, "reset", "--soft", "HEAD~1");
  await observe();

  expect(model.get(key("app.ts"))?.status).toBe("modified");
  expect(await baseline("app.ts")).toBe(`${APP.join("\n")}\n`);
});

test("a write that lands after the pull is not adopted with it", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();

  await upstreamCommit("app.ts");
  pull();
  // The agent wrote inside the window between the pull and the sync noticing it.
  await write("app.ts", "written by an agent\n");
  await gitFinished();
  await observe();

  // The file no longer holds what Git left there, so it is not Git's write to adopt.
  expect(model.get(key("app.ts"))?.status).toBe("modified");
  expect(await baseline("app.ts")).toBe(`${APP.join("\n")}\n`);
});

test("a write landing before the ownership check is reviewed, not adopted", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();

  await upstreamCommit("app.ts", "other.ts");
  pull();
  await gitFinished();

  // The snapshot runs before the check that establishes what Git owns. This writes `app.ts` while
  // the snapshot is being taken, so the write is on disk by the time the check runs.
  const stat = editor.workspace.fs.stat.bind(editor.workspace.fs);
  let injected = false;
  vi.spyOn(editor.workspace.fs, "stat").mockImplementation(async (uri) => {
    const recorded = await stat(uri);
    if (!injected && uri.fsPath === fsPath("app.ts")) {
      injected = true;
      await write("app.ts", "written by an agent\n");
    }
    return recorded;
  });

  await observe();
  vi.restoreAllMocks();
  await gitFinished();

  // Adopting here would have made the agent's write the baseline and dropped it from the review.
  expect(model.files.map((file) => file.key)).toEqual([key("app.ts")]);
  expect(model.get(key("app.ts"))?.currentText).toBe("written by an agent\n");
  expect(await baseline("app.ts")).toBe(`${APP.join("\n")}\n`);
  // The rest of the pull was Git's alone, and is adopted as before.
  expect(await baseline("other.ts")).toBe("pulled\n");
});

test("a write landing after the ownership check is reviewed, not adopted", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();

  await upstreamCommit("app.ts", "other.ts");
  pull();
  await gitFinished();

  // The other side of the pair, stepped through by hand because the write has to land between two
  // calls the sync makes back to back: after Git has confirmed it owns both files, before the
  // adoption reads them. The check cannot see this write, so only the snapshot can catch it.
  const candidates = await changedPaths(workspace, [{ from: "HEAD~1", to: "HEAD" }]);
  const uris = candidates.map((target) => editor.asUri(editor.Uri.file(target)));
  const recorded = await model.snapshotDisk(uris);
  const owned = must(await pathsMatchingHead(workspace, candidates), "the files Git owns");
  expect(owned).toHaveLength(2);

  await write("app.ts", "written by an agent\n");
  await model.absorbGitRewrite(
    owned.map((target) => editor.asUri(editor.Uri.file(target))),
    recorded,
  );
  await gitFinished();

  expect(model.files.map((file) => file.key)).toEqual([key("app.ts")]);
  expect(await baseline("app.ts")).toBe(`${APP.join("\n")}\n`);
  expect(await baseline("other.ts")).toBe("pulled\n");
});

test("a write landing while the file is being read is reviewed, not adopted", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();

  await upstreamCommit("app.ts", "other.ts");
  pull();
  await gitFinished();

  // The narrowest gap of the three: a reading stats the file before it reads it, so this writes
  // `app.ts` after its stat was taken and before its content is. Both checks so far have already
  // passed by then, and the content coming back is the agent's.
  const readFile = editor.workspace.fs.readFile.bind(editor.workspace.fs);
  let injected = false;
  vi.spyOn(editor.workspace.fs, "readFile").mockImplementation(async (uri) => {
    if (!injected && uri.fsPath === fsPath("app.ts")) {
      injected = true;
      await write("app.ts", "written by an agent\n");
    }
    return readFile(uri);
  });

  await observe();
  vi.restoreAllMocks();
  await gitFinished();

  expect(model.files.map((file) => file.key)).toEqual([key("app.ts")]);
  expect(model.get(key("app.ts"))?.currentText).toBe("written by an agent\n");
  expect(await baseline("app.ts")).toBe(`${APP.join("\n")}\n`);
  expect(await baseline("other.ts")).toBe("pulled\n");
});

// Windows forbids a backslash in a file name, so only the platforms where one is an ordinary
// character can be asked what happens when Git reports it.
test.skipIf(process.platform === "win32")(
  "a backslash in a file name does not slip past the ownership check",
  async () => {
    const awkward = "od\\jednom.ts";
    await clonedRepository();
    // The file has to come from upstream, so that a later pull is what rewrites it.
    await write(awkward, "first\n", origin);
    git(origin, "add", "-A");
    git(origin, "commit", "-m", "an awkward name");
    pull();
    await model.initialize();
    await observe();

    await write(awkward, "pulled\n", origin);
    await upstreamCommit("app.ts");
    pull();
    // Written after the pull, before anything has looked at the file, so the ownership check is
    // the only thing that can catch it. Comparing Git's answer as text would read the backslash
    // as a separator, miss this file, and let the snapshot record the agent's write as Git's.
    await write(awkward, "written by an agent\n");
    await gitFinished();
    await observe();

    expect(model.files.map((file) => file.key)).toEqual([key(awkward)]);
    expect(model.get(key(awkward))?.currentText).toBe("written by an agent\n");
    expect(await baseline(awkward)).toBe("first\n");
    expect(await baseline("app.ts")).toBe(`${["pulled", ...APP.slice(1)].join("\n")}\n`);
  },
);

// ── what a rewrite is allowed to take with it ──────────────────────────────

test("a pull over an unaccepted change Git had committed adopts it, without asking", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();
  await agentWrote("app.ts", agentApp());
  // Committed, so the pull merges rather than refusing to overwrite a modified file. Git owns
  // what is on disk from here on, and the change is in its history rather than only in a review.
  git(workspace, "commit", "-am", "commit the agent's work");

  await upstreamCommit("app.ts", "other.ts");
  pull();
  await gitFinished();
  await observe();

  expect(editor.state.shown).toEqual([]);
  expect(model.files).toEqual([]);
});

test("a pull cannot take an unaccepted change that was never committed", async () => {
  await clonedRepository();
  await model.initialize();
  await observe();
  await agentWrote("app.ts", agentApp());

  // Git refuses to overwrite a modified file, so the pull touches everything except this one.
  await upstreamCommit("other.ts");
  pull();
  await gitFinished();
  await observe();

  expect(model.files.map((file) => file.key)).toEqual([key("app.ts")]);
  expect(model.get(key("app.ts"))?.baselineText).toBe(`${APP.join("\n")}\n`);
  expect(await baseline("other.ts")).toBe("pulled\n");
});

// ── merges that stop on a conflict ─────────────────────────────────────────

/** A pull whose merge conflicts, leaving Git's markers in `app.ts` and the merge unfinished. */
async function conflictedPull(): Promise<void> {
  await clonedRepository();
  await write("app.ts", `${["local", ...APP.slice(1)].join("\n")}\n`);
  git(workspace, "commit", "-am", "local work");
  // The baseline is the committed local state, so nothing is pending when the merge begins.
  await model.initialize();
  await observe();

  await upstreamCommit("app.ts");
  pullIntoConflict();
  await gitFinished();
}

test("a conflicted merge shows Git's markers until it is finished", async () => {
  await conflictedPull();
  await observe();

  // Nothing moved HEAD, so there is nothing to attribute the write to yet. The file is left as
  // Git wrote it, alongside Git's own conflict handling, rather than being adopted mid-merge.
  expect(model.get(key("app.ts"))?.currentText).toContain("<<<<<<<");
});

test("resolving a conflicted merge and committing it leaves nothing pending", async () => {
  await conflictedPull();
  await observe();

  await write("app.ts", `${["resolved", ...APP.slice(1)].join("\n")}\n`);
  git(workspace, "add", ".");
  git(workspace, "commit", "--no-edit");
  await gitFinished();
  await observe();

  // The merge commit is where Git's work becomes attributable: the range it closes covers every
  // file the merge wrote, markers and resolution alike.
  expect(model.files).toEqual([]);
  expect(await baseline("app.ts")).toBe(`${["resolved", ...APP.slice(1)].join("\n")}\n`);
});

test("aborting a conflicted merge leaves nothing pending", async () => {
  await conflictedPull();
  await observe();

  git(workspace, "merge", "--abort");
  await gitFinished();
  await observe();

  // The abort restores exactly what the baseline was captured from, so the review empties itself.
  expect(model.files).toEqual([]);
  expect(await baseline("app.ts")).toBe(`${["local", ...APP.slice(1)].join("\n")}\n`);
});

// ── across a reload ────────────────────────────────────────────────────────

test("a pull made while the window was closed is absorbed on the next activation", async () => {
  await clonedRepository();
  await model.initialize();
  // The window that recorded where HEAD stood is gone; only its workspace state remains.
  await new GitSync(model, editor.workspaceState).sync(workspace);

  await upstreamCommit("app.ts");
  pull();
  await gitFinished();
  await new GitSync(model, editor.workspaceState).sync(workspace);

  expect(model.files).toEqual([]);
  expect(await baseline("app.ts")).toBe(`${["pulled", ...APP.slice(1)].join("\n")}\n`);
});

test("nothing is absorbed before a baseline exists", async () => {
  await clonedRepository();
  const absorb = vi.spyOn(model, "absorbGitRewrite");

  await upstreamCommit("app.ts");
  pull();
  // Activation failed or has not finished, so there is no baseline to absorb into.
  expect(model.ready).toBe(false);
  await observe();

  expect(absorb).not.toHaveBeenCalled();
});

test("a folder that is not a repository is left alone", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await observe();
  await agentWrote("a.ts", "written by an agent\n");

  await observe();

  expect(model.get(key("a.ts"))?.status).toBe("modified");
});

// ── the wholesale reset a repository without a reflog still needs ──────────

test("a branch switch with nothing pending resets the baseline without asking", async () => {
  await write("a.ts", "on main\n");
  await model.initialize();

  await write("a.ts", "on the feature branch\n");
  await resetForBranchSwitch(model);

  // Nothing was under review, so every rewritten file belongs to the checkout, not to an agent.
  expect(editor.state.shown).toEqual([]);
  expect(model.files).toEqual([]);
  expect(await baseline("a.ts")).toBe("on the feature branch\n");
});

test("a branch switch with pending work asks before discarding the review", async () => {
  await write("a.ts", "on main\n");
  await model.initialize();
  await agentWrote("a.ts", "written by an agent\n");

  userClicks(RESET_BASELINE);
  await resetForBranchSwitch(model);

  expect(editor.state.shown.at(-1)?.message).toBe(BRANCH_CHANGED_PROMPT);
  expect(editor.state.shown.at(-1)?.items).toEqual([RESET_BASELINE, KEEP_PENDING]);
  expect(model.files).toEqual([]);
  expect(await baseline("a.ts")).toBe("written by an agent\n");
});

test("keeping the pending changes leaves the baseline where it was", async () => {
  await write("a.ts", "on main\n");
  await model.initialize();
  await agentWrote("a.ts", "written by an agent\n");

  userClicks(KEEP_PENDING);
  await resetForBranchSwitch(model);

  expect(model.get(key("a.ts"))?.status).toBe("modified");
  expect(model.get(key("a.ts"))?.baselineText).toBe("on main\n");
});
