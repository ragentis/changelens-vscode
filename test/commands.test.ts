import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { normalizeKey } from "../src/core/paths";
import { registerCommands, resolveKey } from "../src/commands";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import { ReviewFileSystemProvider } from "../src/ui/reviewFileSystemProvider";
import { REVIEW_SCHEME } from "../src/ui/schemes";
import { ageBlobs } from "./helpers/blobs";
import * as editor from "./helpers/vscode";

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;

const blobsRoot = () => path.join(root, "state", "blobs");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-commands-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store, editor.workspaceState);
  registerCommands(editor.createExtensionContext(), model, store);
});

afterEach(async () => {
  vi.restoreAllMocks();
  model.dispose();
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

function fsPath(name: string): string {
  return path.join(workspace, name);
}

function uri(name: string) {
  return editor.Uri.file(fsPath(name));
}

function key(name: string): string {
  return normalizeKey(fsPath(name));
}

async function write(name: string, text: string): Promise<void> {
  await fs.writeFile(fsPath(name), text, "utf8");
}

/** Reports the file as changed on disk, the way the watcher would. */
async function agentWrote(name: string, text: string): Promise<void> {
  await write(name, text);
  await model.handleDiskWrite(editor.asUri(uri(name)));
}

/** Answers every dialog with the given button, or dismisses it when omitted. */
function userClicks(label?: string): void {
  editor.state.answer = (_message, items) =>
    label !== undefined && items.includes(label) ? label : undefined;
}

function lastMessage(): string {
  return editor.state.shown.at(-1)?.message ?? "";
}

// #region resolving the target file

test("a command target is resolved from a key, a uri or a tree node", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  expect(resolveKey(model, key("a.ts"))).toBe(key("a.ts"));
  expect(resolveKey(model, uri("a.ts"))).toBe(key("a.ts"));
  expect(resolveKey(model, { file: { key: key("a.ts") } })).toBe(key("a.ts"));
});

test("a review uri resolves back to the file it is reviewing", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  expect(resolveKey(model, uri("a.ts").with({ scheme: REVIEW_SCHEME }))).toBe(key("a.ts"));
});

test("without an argument the active editor decides, and only if it has a change", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "quiet\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  editor.setActiveEditor(editor.openDocument(fsPath("b.ts"), "quiet\n"));
  expect(resolveKey(model, undefined)).toBeUndefined();

  editor.setActiveEditor(editor.openDocument(fsPath("a.ts"), "one\ntwo\n"));
  expect(resolveKey(model, undefined)).toBe(key("a.ts"));
});

test("with no editor at all there is nothing to resolve and nothing to review", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  // Every command is also reachable from the palette, where no editor need be open at all.
  expect(editor.state.activeTextEditor).toBeUndefined();
  expect(resolveKey(model, undefined)).toBeUndefined();

  await editor.run("changelens.acceptHunkAtCursor");
  expect(lastMessage()).toContain("no reviewable block");
  expect(model.files).toHaveLength(1);
});

// #endregion

// #region accepting and reverting

test("accepting a file through the command adopts its content", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  await editor.run("changelens.acceptFile", key("a.ts"));

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("reverting a file the agent added asks before deleting it", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("new.ts", "added by an agent\n");

  userClicks();
  await editor.run("changelens.revertFile", key("new.ts"));
  expect(nodeFs.existsSync(fsPath("new.ts"))).toBe(true);
  expect(lastMessage()).toContain("Delete");

  userClicks("Delete File");
  await editor.run("changelens.revertFile", key("new.ts"));
  expect(nodeFs.existsSync(fsPath("new.ts"))).toBe(false);
});

/**
 * Runs a command whose guard passes while the store is still initialized, then lets a capture
 * queued ahead of it fail, so the model turns the command down only once it reaches the chain.
 */
async function refusedByLateCapture(command: string, ...args: unknown[]): Promise<void> {
  const capture = failCapture();
  const ran = editor.run(command, ...args);
  await capture;
  await ran;
}

/** Leaves the store uninitialized, the way a capture that died partway through does. */
async function failCapture(): Promise<void> {
  vi.spyOn(store, "setText").mockImplementationOnce(() => Promise.reject(new Error("disk full")));
  await expect(model.captureBaseline(false)).rejects.toThrow("disk full");
  await model.reconcile();
}

test("an incomplete baseline refuses to revert a file it never recorded", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await failCapture();

  // Nothing recorded it, so it reads as an addition, and reverting an addition is a deletion.
  expect(model.get(key("a.ts"))?.status).toBe("added");

  userClicks("Delete File");
  await editor.run("changelens.revertFile", key("a.ts"));

  expect(nodeFs.existsSync(fsPath("a.ts"))).toBe(true);
  expect(lastMessage()).toContain("baseline is incomplete");
});

test("an incomplete baseline refuses to accept everything it never recorded", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await failCapture();

  userClicks("Accept All");
  await editor.run("changelens.acceptAll");

  expect(store.has(key("a.ts"))).toBe(false);
  expect(lastMessage()).toContain("baseline is incomplete");
});

test("the capture offered by the refusal restores the review", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await failCapture();

  userClicks("Capture Baseline");
  await editor.run("changelens.acceptFile", key("a.ts"));
  await model.drain();

  expect(model.reviewable).toBe(true);
  expect(store.has(key("a.ts"))).toBe(true);
});

test("a file tracked without content cannot be reverted and says why", async () => {
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x01]));
  await model.initialize();
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x02, 0x03]));
  await model.handleDiskWrite(editor.asUri(uri("logo.png")));

  await editor.run("changelens.revertFile", key("logo.png"));

  expect(lastMessage()).toContain("tracked without content");
  expect(model.get(key("logo.png"))).toBeDefined();
});

test("a baseline that fails while the command waits blames the baseline, not the diff", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const signature = model.get(key("a.ts"))?.signatures[0];
  expect(signature).toBeDefined();

  await refusedByLateCapture("changelens.acceptHunk", key("a.ts"), signature);

  expect(lastMessage()).toContain("baseline is incomplete");
  expect(lastMessage()).not.toContain("no longer current");
});

test("accepting a file late in a failed capture says so instead of doing nothing", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one changed\n");

  // `acceptFile` answers with `void`, so without the guard running a second time this refusal is
  // indistinguishable from having succeeded.
  await refusedByLateCapture("changelens.acceptFile", key("a.ts"));

  expect(lastMessage()).toContain("baseline is incomplete");
  expect(store.has(key("a.ts"))).toBe(false);
});

test("accepting everything late in a failed capture says so instead of doing nothing", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one changed\n");

  userClicks("Accept All");
  await refusedByLateCapture("changelens.acceptAll");

  expect(lastMessage()).toContain("baseline is incomplete");
  expect(store.has(key("a.ts"))).toBe(false);
});

test("reverting everything late in a failed capture says so instead of doing nothing", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one changed\n");

  userClicks("Revert All");
  await refusedByLateCapture("changelens.revertAll");

  expect(lastMessage()).toContain("baseline is incomplete");
  expect(await fs.readFile(fsPath("a.ts"), "utf8")).toBe("one changed\n");
});

test("a file revert that no longer matches warns instead of failing silently", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one changed\n");

  // The model answers `false` here; without the warning the command would look like it worked.
  editor.openDocument(fsPath("a.ts"), "changed again\n", true);
  await editor.run("changelens.revertFile", key("a.ts"));

  expect(lastMessage()).toContain("changed since this diff was computed");
});

test("a hunk command that no longer matches warns instead of failing silently", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  await editor.run("changelens.acceptHunk", key("a.ts"), "not-a-signature");

  expect(lastMessage()).toContain("no longer current");
});

test("accepting everything is confirmed first", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  await agentWrote("a.ts", "one changed\n");
  await agentWrote("b.ts", "two changed\n");

  userClicks();
  await editor.run("changelens.acceptAll");
  expect(model.files).toHaveLength(2);

  userClicks("Accept All");
  await editor.run("changelens.acceptAll");
  expect(model.files).toEqual([]);
});

test("reverting everything is confirmed first", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one changed\n");

  // Dismissing has to leave the workspace alone. Unlike Accept All, this one rewrites files.
  userClicks();
  await editor.run("changelens.revertAll");

  expect(model.files).toHaveLength(1);
  expect(await fs.readFile(fsPath("a.ts"), "utf8")).toBe("one changed\n");
});

test("reverting everything lists the files and reports what could not be reverted", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  await agentWrote("a.ts", "one changed\n");
  await agentWrote("b.ts", "two changed\n");

  // The buffer moved on after the diff was computed, so this one has to fail.
  editor.openDocument(fsPath("b.ts"), "two changed again\n", true);

  userClicks("Revert All");
  await editor.run("changelens.revertAll");

  expect(editor.state.shown.at(-2)?.message).toContain("Revert all changes in 2 files");
  expect(lastMessage()).toContain("b.ts");
});

test("a long revert list is previewed rather than printed in full", async () => {
  const names = Array.from(
    { length: 13 },
    (_, index) => `file${String(index).padStart(2, "0")}.ts`,
  );
  await Promise.all(names.map((name) => write(name, "one\n")));
  await model.initialize();
  await Promise.all(names.map((name) => agentWrote(name, "one changed\n")));

  userClicks();
  await editor.run("changelens.revertAll");

  // A modal that lists every file grows past the screen, so the dialog shows ten and counts the
  // rest. The count is what tells the user the list is not the whole story.
  const detail = editor.state.shown.at(-1)?.detail ?? "";
  expect(detail).toContain("file00.ts");
  expect(detail).toContain("file09.ts");
  expect(detail).not.toContain("file10.ts");
  expect(detail).toContain("… and 3 more");
});

test("nothing is asked when there is nothing to accept or revert", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await editor.run("changelens.acceptAll");
  await editor.run("changelens.revertAll");

  expect(editor.state.shown).toEqual([]);
});

// #endregion

// #region cursor-driven review

test("the block at the cursor is the one accepted", async () => {
  await write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  await model.initialize();
  await agentWrote("a.ts", "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");

  const file = model.get(key("a.ts"));
  expect(file?.hunks).toHaveLength(2);

  const doc = editor.openDocument(fsPath("a.ts"), "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  editor.setActiveEditor(doc, 6);
  await editor.run("changelens.acceptHunkAtCursor");

  // The second block was accepted, so the first is what is left to review.
  const remaining = model.get(key("a.ts"));
  expect(remaining?.hunks).toHaveLength(1);
  expect(remaining?.hunks[0]?.currLines).toEqual(["ONE"]);
});

test("the block at the cursor is also the one reverted", async () => {
  await write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  await model.initialize();
  await agentWrote("a.ts", "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");

  const doc = editor.openDocument(fsPath("a.ts"), "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  editor.setActiveEditor(doc, 6);
  await editor.run("changelens.revertHunkAtCursor");

  // The second block went back to the baseline line; the first is untouched and still pending.
  expect(doc.getText()).toBe("ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  expect(model.get(key("a.ts"))?.hunks).toHaveLength(1);
});

test("a hunk revert refused late in a failed capture blames the baseline too", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const signature = model.get(key("a.ts"))?.signatures[0];

  await refusedByLateCapture("changelens.revertHunk", key("a.ts"), signature);

  expect(lastMessage()).toContain("baseline is incomplete");
  expect(lastMessage()).not.toContain("changed since this diff");
});

test("the cursor command does nothing when the active file has no change", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  editor.setActiveEditor(editor.openDocument(fsPath("a.ts"), "one\n"));
  await editor.run("changelens.acceptHunkAtCursor");

  expect(editor.state.executed).toEqual([]);
});

// #endregion

// #region opening a review

test("a change opens in the unified review editor", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");
  const provider = new ReviewFileSystemProvider(model);
  editor.workspace.registerFileSystemProvider(REVIEW_SCHEME, provider, { isReadonly: true });

  await editor.run("changelens.openDiff", key("a.ts"));

  expect(editor.state.shownDocuments.at(-1)?.scheme).toBe(REVIEW_SCHEME);
  provider.dispose();
});

test("the diff editor mode opens the built-in diff instead", async () => {
  editor.state.configuration.set("changelens.defaultReviewMode", "diffEditor");
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  await editor.run("changelens.openDiff", key("a.ts"));

  expect(editor.state.executed.at(-1)?.command).toBe("vscode.diff");
});

test("a file with no diff opens as itself", async () => {
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x01]));
  await model.initialize();
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x02, 0x03]));
  await model.handleDiskWrite(editor.asUri(uri("logo.png")));

  await editor.run("changelens.openDiff", key("logo.png"));

  expect(editor.state.shownDocuments.at(-1)?.scheme).toBe("file");
});

test("toggling the review mode flips it back and forth", async () => {
  await editor.run("changelens.toggleReviewMode");
  expect(model.config.reviewMode).toBe("diffEditor");
  expect(editor.state.workspaceState.get("changelens.reviewMode")).toBe("diffEditor");

  await editor.run("changelens.toggleReviewMode");
  expect(model.config.reviewMode).toBe("unified");
  expect(editor.state.workspaceState.get("changelens.reviewMode")).toBe("unified");
});

// #endregion

// #region workspace-wide commands

test("refresh finds a write no watcher reported", async () => {
  const stamp = new Date(Date.now() - 60_000);
  await write("a.ts", "one\n");
  await fs.utimes(fsPath("a.ts"), stamp, stamp);
  await model.initialize();

  await write("a.ts", "ONE\n");
  await fs.utimes(fsPath("a.ts"), stamp, stamp);

  await editor.run("changelens.refresh");
  expect(model.get(key("a.ts"))?.status).toBe("modified");
});

test("resetting the baseline is confirmed first", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  userClicks();
  await editor.run("changelens.rebaseline");
  expect(model.files).toHaveLength(1);

  userClicks("Reset Baseline");
  await editor.run("changelens.rebaseline");
  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("a reset whose capture fails reports once, through the capture itself", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  vi.spyOn(store, "setText").mockImplementationOnce(() => Promise.reject(new Error("disk full")));
  userClicks("Reset Baseline");

  // The command swallows the rejection: letting it out would stack VS Code's own generic "command
  // failed" notice on top of the message the capture has already shown.
  await expect(editor.run("changelens.rebaseline")).resolves.toBeUndefined();

  expect(lastMessage()).toContain("could not finish resetting the baseline");
  expect(model.reviewable).toBe(false);
});

test("resetting the baseline reclaims the content it replaced", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");
  await store.flush();
  expect(await ageBlobs(blobsRoot())).toHaveLength(1);

  userClicks("Reset Baseline");
  await editor.run("changelens.rebaseline");

  // The replaced baseline is the largest thing a reset leaves behind, so it goes with the reset
  // rather than waiting for the next activation to sweep it up.
  expect(await ageBlobs(blobsRoot())).toHaveLength(1);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("the view mode commands set the mode they name", async () => {
  await editor.run("changelens.viewAsList");
  expect(model.config.viewMode).toBe("list");

  await editor.run("changelens.viewAsTree");
  expect(model.config.viewMode).toBe("tree");
  expect(editor.state.workspaceState.get("changelens.viewMode")).toBe("tree");
});

test("a toggle is remembered per workspace instead of writing a setting", async () => {
  await editor.run("changelens.viewAsList");
  await editor.run("changelens.toggleReviewMode");

  expect(model.config.viewMode).toBe("list");
  expect(model.config.reviewMode).toBe("diffEditor");
  expect(editor.state.workspaceState.get("changelens.viewMode")).toBe("list");
  expect(editor.state.workspaceState.get("changelens.reviewMode")).toBe("diffEditor");
  // Settings stay untouched, so a toggle never adds a settings file to the repository.
  expect(editor.state.configuration.size).toBe(0);
  expect(editor.state.workspaceConfiguration.size).toBe(0);
});

test("a remembered toggle outranks the configured default and survives a reload", async () => {
  editor.state.configuration.set("changelens.defaultViewMode", "tree");
  editor.state.configuration.set("changelens.defaultReviewMode", "unified");
  await editor.run("changelens.viewAsList");
  await editor.run("changelens.toggleReviewMode");

  await model.reloadConfig();
  expect(model.config.viewMode).toBe("list");
  expect(model.config.reviewMode).toBe("diffEditor");

  const reopened = new ChangeModel(store, editor.workspaceState);
  expect(reopened.config.viewMode).toBe("list");
  expect(reopened.config.reviewMode).toBe("diffEditor");
  reopened.dispose();
});

test("without a remembered toggle the configured defaults decide", () => {
  editor.state.configuration.set("changelens.defaultViewMode", "list");
  editor.state.configuration.set("changelens.defaultReviewMode", "diffEditor");

  const opened = new ChangeModel(store, editor.workspaceState);

  expect(opened.config.viewMode).toBe("list");
  expect(opened.config.reviewMode).toBe("diffEditor");
  opened.dispose();
});

test("a toggle whose write fails leaves the model on the mode still on screen", async () => {
  const guarded = new ChangeModel(store, editor.failingWorkspaceState("state is full"));
  let redraws = 0;
  const listener = guarded.onDidChange(() => (redraws += 1));

  await expect(guarded.setViewMode("list")).rejects.toThrow("state is full");
  await expect(guarded.toggleReviewMode()).rejects.toThrow("state is full");

  // Publishing before the write lands would leave the model ahead of a view that never redrew.
  expect(guarded.config.viewMode).toBe("tree");
  expect(guarded.config.reviewMode).toBe("unified");
  expect(redraws).toBe(0);
  listener.dispose();
  guarded.dispose();
});

test("a failed toggle does not strand the toggles queued behind it", async () => {
  const guarded = new ChangeModel(store, editor.failingWorkspaceState("state is full"));

  const failed = guarded.setViewMode("list");
  const behind = guarded.setViewMode("list");

  await expect(failed).rejects.toThrow("state is full");
  await expect(behind).rejects.toThrow("state is full");
  guarded.dispose();
});

test("two review toggles fired together land on different modes, not the same one", async () => {
  const queued = new ChangeModel(store, editor.deferredWorkspaceState());

  // The second reads the mode only once the first write landed, so it flips back instead of
  // repeating the first flip.
  const both = await Promise.all([queued.toggleReviewMode(), queued.toggleReviewMode()]);

  expect(both).toEqual(["diffEditor", "unified"]);
  expect(queued.config.reviewMode).toBe("unified");
  queued.dispose();
});

test("shutdown drains a mode write that is still in flight", async () => {
  const slow = editor.deferredWorkspaceState();
  const closing = new ChangeModel(store, slow);

  const pending = closing.setViewMode("list");
  // `deactivate` drains and then flushes, so a write still in the air here is a lost choice.
  await closing.drain();

  expect(slow.get<string>("changelens.viewMode")).toBe("list");
  await pending;
  closing.dispose();
});

test("a view mode command fired during the previous write is not dropped as a no-op", async () => {
  const queued = new ChangeModel(store, editor.deferredWorkspaceState());

  // Comparing against the not-yet-published mode would make this look like it was already tree.
  await Promise.all([queued.setViewMode("list"), queued.setViewMode("tree")]);

  expect(queued.config.viewMode).toBe("tree");
  queued.dispose();
});

// #endregion
