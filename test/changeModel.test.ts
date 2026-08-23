import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { normalizeKey } from "../src/core/paths";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import { must } from "./helpers/assert";
import { deferred } from "./helpers/async";
import * as editor from "./helpers/vscode";

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-model-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
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
  return editor.asUri(editor.Uri.file(fsPath(name)));
}

function key(name: string): string {
  return normalizeKey(fsPath(name));
}

async function write(name: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(fsPath(name)), { recursive: true });
  await fs.writeFile(fsPath(name), text, "utf8");
}

async function readDisk(name: string): Promise<string> {
  return fs.readFile(fsPath(name), "utf8");
}

/** Opens a buffer over a file and tells the model about it, as the editor would. */
function open(name: string, text: string): editor.TextDocument {
  const doc = editor.openDocument(fsPath(name), text);
  model.handleDocumentOpened(editor.asDocument(doc));
  return doc;
}

/** Simulates typing: replaces the buffer text and reports the change. */
async function type(doc: editor.TextDocument, text: string): Promise<void> {
  doc.setText(text);
  doc.isDirty = true;
  await model.handleBufferChange(editor.asDocument(doc));
}

/**
 * Simulates Ctrl+S before the buffer debounce fires: the buffer text reaches disk and the save
 * is reported, but `handleBufferChange` has not run for the keystrokes yet.
 */
async function saveWithoutBufferChange(doc: editor.TextDocument, text: string): Promise<void> {
  doc.setText(text);
  doc.isDirty = true;
  await fs.writeFile(doc.uri.fsPath, text, "utf8");
  doc.isDirty = false;
  await model.handleSave(editor.asDocument(doc));
}

/**
 * Simulates _Revert File_, or the reload behind _Don't Save_: VS Code reads the file back into
 * the buffer, which reaches the model as a clean buffer change holding the disk text.
 */
async function revert(doc: editor.TextDocument): Promise<void> {
  doc.setText(await fs.readFile(doc.uri.fsPath, "utf8"));
  doc.isDirty = false;
  await model.handleBufferChange(editor.asDocument(doc));
}

/**
 * Simulates _Don't Save_ on close, where the close is handled before the reverting buffer change
 * leaves its debounce.
 */
async function closeWithoutSaving(doc: editor.TextDocument): Promise<void> {
  doc.setText(await fs.readFile(doc.uri.fsPath, "utf8"));
  editor.closeDocument(doc);
  await model.handleDocumentClosed(editor.asDocument(doc));
  await model.handleBufferChange(editor.asDocument(doc));
}

/** An operation parked mid-flight: `entered` settles once it is reached, `release` lets it go. */
interface Gate {
  entered: Promise<void>;
  release: () => void;
}

/** Holds the `.gitignore` read a filter rebuild awaits, so an event can land mid-rebuild. */
function holdGitignoreRead(): Gate {
  const entered = deferred();
  const held = deferred();
  const original = editor.workspace.fs.readFile.bind(editor.workspace.fs);
  vi.spyOn(editor.workspace.fs, "readFile").mockImplementation(async (target) => {
    if (target.fsPath.endsWith(".gitignore")) {
      entered.resolve();
      await held.promise;
    }
    return original(target);
  });
  return { entered: entered.promise, release: held.resolve };
}

/**
 * Holds a capture open after it has listed the workspace, so an event can be raised at the one
 * moment that matters: the baseline is being rebuilt and the file involved is no longer listed.
 */
function holdCapture(): Gate {
  const entered = deferred();
  const held = deferred();
  const original = editor.window.withProgress.bind(editor.window);
  vi.spyOn(editor.window, "withProgress").mockImplementation(async (options, task) => {
    entered.resolve();
    await held.promise;
    return original(options, task);
  });
  return { entered: entered.promise, release: held.resolve };
}

/**
 * Holds a Git adoption open at its final flush, so an event can be raised while the model is
 * deferring events and the baseline it will be replayed against already exists.
 */
function holdAbsorb(): Gate {
  const entered = deferred();
  const held = deferred();
  const original = store.flush.bind(store);
  const spy = vi.spyOn(store, "flush").mockImplementation(async () => {
    spy.mockRestore();
    entered.resolve();
    await held.promise;
    return original();
  });
  return { entered: entered.promise, release: held.resolve };
}

// #region baseline

test("the initial capture leaves no pending changes", async () => {
  await write("a.ts", "one\ntwo\n");
  await write(path.join("src", "b.ts"), "three\n");
  await model.initialize();

  expect(model.files).toEqual([]);
  expect(model.ready).toBe(true);
  expect(store.initialized).toBe(true);
  expect(store.size).toBe(2);
});

test("an external write shows up as a modified file with hunks", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();

  await write("a.ts", "one\nTWO\n");
  await model.handleDiskWrite(uri("a.ts"));

  const file = model.get(key("a.ts"));
  expect(file?.status).toBe("modified");
  expect(file?.opaqueReason).toBeNull();
  expect(file?.hunks).toHaveLength(1);
  expect(file?.added).toBe(1);
  expect(file?.removed).toBe(1);
  expect(file?.unified).not.toBeNull();
});

test("an external create shows up as added and a delete as deleted", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("new.ts", "fresh\n");
  await model.handleDiskWrite(uri("new.ts"));
  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));

  expect(model.get(key("new.ts"))?.status).toBe("added");
  expect(model.get(key("a.ts"))?.status).toBe("deleted");
  expect(model.get(key("a.ts"))?.baselineText).toBe("one\n");
});

test("a deletion is reported even while a clean editor still shows the file", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  // VS Code keeps the document open after the file is gone, with the text it last loaded.
  open("a.ts", "one\n");

  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));

  expect(model.get(key("a.ts"))?.status).toBe("deleted");
});

test("an unsaved buffer stands in for a deleted file until it is saved or discarded", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  const doc = open("a.ts", "one\n");
  await type(doc, "one\ntwo\n");

  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));

  expect(model.files).toEqual([]);
});

test("an empty file reaches the review when it is created or deleted", async () => {
  await write("a.ts", "");
  await model.initialize();

  await write("empty.ts", "");
  await model.handleDiskWrite(uri("empty.ts"));
  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));

  expect(model.get(key("empty.ts"))?.status).toBe("added");
  expect(model.get(key("empty.ts"))?.opaqueReason).toBeNull();
  expect(model.get(key("a.ts"))?.status).toBe("deleted");
});

test("an empty added file can be accepted and an empty deleted file recreated", async () => {
  await write("a.ts", "");
  await model.initialize();

  await write("empty.ts", "");
  await model.handleDiskWrite(uri("empty.ts"));
  await model.acceptFile(key("empty.ts"));
  expect(await store.readBaseline(key("empty.ts"))).toEqual({
    kind: "text",
    text: "",
    hadBom: false,
  });

  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));
  expect(await model.revertFile(key("a.ts"))).toBe(true);

  expect(await readDisk("a.ts")).toBe("");
  expect(model.files).toEqual([]);
});

test("reverting an empty added file deletes it from disk", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("empty.ts", "");
  await model.handleDiskWrite(uri("empty.ts"));
  expect(await model.revertFile(key("empty.ts"))).toBe(true);

  expect(nodeFs.existsSync(fsPath("empty.ts"))).toBe(false);
  expect(model.files).toEqual([]);
});

test("a write that does not change the file is not reported", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("a.ts", "one\n");
  await model.handleDiskWrite(uri("a.ts"));

  expect(model.files).toEqual([]);
});

test("a file the filter excludes is never tracked", async () => {
  editor.state.configuration.set("changelens.exclude", ["**/ignored/**"]);
  await write(path.join("ignored", "a.ts"), "one\n");
  await write("b.ts", "two\n");
  await model.initialize();

  expect(store.size).toBe(1);
  expect(store.has(key(path.join("ignored", "a.ts")))).toBe(false);
});

test("a gitignore negation does not undo an exclude setting", async () => {
  await write(".gitignore", "private/**\n!private/a.ts\n");
  editor.state.configuration.set("changelens.exclude", ["private/**"]);
  await write(path.join("private", "a.ts"), "one\n");
  await write("b.ts", "two\n");
  await model.initialize();

  expect(store.has(key(path.join("private", "a.ts")))).toBe(false);

  // The scan already left this file out; the event path has to agree, or it reappears as new.
  await write(path.join("private", "a.ts"), "changed\n");
  await model.handleDiskWrite(uri(path.join("private", "a.ts")));

  expect(model.files).toEqual([]);
});

test("a gitignored file is not tracked, and a negation inside the gitignore puts it back", async () => {
  await write(".gitignore", "*.log\n!keep.log\n");
  await write("debug.log", "noise\n");
  await write("keep.log", "wanted\n");
  await model.initialize();

  expect(store.has(key("debug.log"))).toBe(false);
  expect(store.has(key("keep.log"))).toBe(true);
});

// #endregion

// #region editor buffers

test("an edit made in the editor is folded into the baseline instead of shown", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();

  const doc = open("a.ts", "one\ntwo\n");
  await type(doc, "one\nTWO\n");

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\nTWO\n",
    hadBom: false,
  });
});

test("an edit made in the editor rebases the baseline without swallowing a pending change", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();

  await write("a.ts", "one\ntwo\nthree\n");
  await model.handleDiskWrite(uri("a.ts"));
  expect(model.get(key("a.ts"))?.added).toBe(1);

  // The user now edits the first line of the same buffer the agent just appended to.
  const doc = open("a.ts", "one\ntwo\nthree\n");
  await type(doc, "ONE\ntwo\nthree\n");

  const file = model.get(key("a.ts"));
  expect(file?.baselineText).toBe("ONE\ntwo\n");
  expect(file?.hunks).toHaveLength(1);
  expect(file?.hunks[0]?.currLines).toEqual(["three"]);
});

test("a reset takes an unsaved buffer as it stands, not the file behind it", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const doc = editor.openDocument(fsPath("a.ts"), "one\nunsaved\n", true);
  model.handleDocumentOpened(editor.asDocument(doc));
  await model.captureBaseline(false);

  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\nunsaved\n",
    hadBom: false,
  });

  // The next keystroke must carry only itself; the earlier unsaved work was already reviewed.
  await type(doc, "one\nunsaved\nmore\n");
  expect(model.files).toEqual([]);
});

test("typing into a clean editor after a reset is still folded, not reviewed", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");

  // The reset forgets what every buffer held; an open one has to be recorded again.
  await model.captureBaseline(false);
  await type(doc, "one\ntwo\nthree\n");

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\nthree\n",
    hadBom: false,
  });
});

test("an external write reloaded into a clean editor is reviewed even when its disk event is late", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");

  // VS Code reloads a clean buffer after an external write. Usually the disk event is handled
  // first; when it is not, the reload must still not pass for something the user typed.
  await write("a.ts", "one\ntwo\nagent\n");
  doc.setText("one\ntwo\nagent\n");
  await model.handleBufferChange(editor.asDocument(doc));

  expect(model.get(key("a.ts"))?.added).toBe(1);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });

  // The disk event arriving afterwards adds nothing.
  await model.handleDiskWrite(uri("a.ts"));
  expect(model.get(key("a.ts"))?.added).toBe(1);
});

test("closing a discarded buffer puts the external write underneath it up for review", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");
  await type(doc, "one\ntwo\nmine\n");

  // The unsaved buffer outranks the agent's write, so nothing is reviewed while it is open.
  await write("a.ts", "one\ntwo\nagent\n");
  await model.handleDiskWrite(uri("a.ts"));
  expect(model.files).toEqual([]);

  // Closed without saving: the buffer is gone and the agent's write is what the file holds. The
  // discarded line must not be reported as removed alongside it.
  await closeWithoutSaving(doc);

  const file = model.get(key("a.ts"));
  expect(file?.status).toBe("modified");
  expect(file?.hunks.map((hunk) => [hunk.baseLines, hunk.currLines])).toEqual([[[], ["agent"]]]);
});

test("closing a discarded buffer over a deleted file reports the deletion", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  const doc = open("a.ts", "one\n");
  await type(doc, "one\ntwo\n");

  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));
  expect(model.files).toEqual([]);

  // There is no file to reload, so the buffer keeps its text until it is closed.
  editor.closeDocument(doc);
  await model.handleDocumentClosed(editor.asDocument(doc));

  const file = model.get(key("a.ts"));
  expect(file?.status).toBe("deleted");
  expect(file?.baselineText).toBe("one\n");
});

test("closing with Don't Save folds the unsaved edits back out of the baseline", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");
  await type(doc, "one\nTWO\nthree\n");
  expect(model.files).toEqual([]);

  await closeWithoutSaving(doc);

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("reverting a file folds the unsaved edits back out of the baseline", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");
  await type(doc, "one\nTWO\n");
  await type(doc, "one\nTWO\nthree\n");

  await revert(doc);

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("discarding edits typed around a pending hunk leaves the hunk as it was", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await write("a.ts", "one\ntwo\nagent\n");
  await model.handleDiskWrite(uri("a.ts"));

  const doc = open("a.ts", "one\ntwo\nagent\n");
  await type(doc, "mine\none\ntwo\nagent\n");
  expect(model.get(key("a.ts"))?.hunks.map((hunk) => hunk.currLines)).toEqual([["agent"]]);

  await revert(doc);

  const file = model.get(key("a.ts"));
  expect(file?.baselineText).toBe("one\ntwo\n");
  expect(file?.hunks.map((hunk) => [hunk.baseLines, hunk.currLines])).toEqual([[[], ["agent"]]]);
});

test("discarding edits reviews the external write that landed underneath them", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");
  await type(doc, "mine\none\ntwo\n");

  await write("a.ts", "one\ntwo\nagent\n");
  await model.handleDiskWrite(uri("a.ts"));
  expect(model.files).toEqual([]);

  // The reload brings the agent's write into the buffer; only the typed line is the user's.
  await revert(doc);

  const file = model.get(key("a.ts"));
  expect(file?.baselineText).toBe("one\ntwo\n");
  expect(file?.hunks.map((hunk) => [hunk.baseLines, hunk.currLines])).toEqual([[[], ["agent"]]]);
});

test("discarding a hunk revert the user typed over puts the hunk back up for review", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await write("a.ts", "one\ntwo\nagent\n");
  await model.handleDiskWrite(uri("a.ts"));
  const signature = must(model.get(key("a.ts"))?.signatures[0], "the hunk's signature");

  const doc = open("a.ts", "one\ntwo\nagent\n");
  expect(await model.revertHunk(key("a.ts"), signature)).toBe(true);
  expect(model.files).toEqual([]);
  await type(doc, "one\nTWO\n");

  await revert(doc);

  const file = model.get(key("a.ts"));
  expect(file?.baselineText).toBe("one\ntwo\n");
  expect(file?.hunks.map((hunk) => [hunk.baseLines, hunk.currLines])).toEqual([[[], ["agent"]]]);
});

test("a baseline reset taken from a dirty buffer follows a discard back to disk", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  const doc = open("a.ts", "one\n");
  await type(doc, "one\ntwo\n");

  await model.captureBaseline(false);
  await revert(doc);

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: false,
  });
});

test("typing back to the saved text and saving leaves nothing in the baseline", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");
  await type(doc, "one\ntwo\nthree\n");

  // Retyped by hand rather than undone, so the buffer stays dirty at the saved text.
  await type(doc, "one\ntwo\n");
  await saveWithoutBufferChange(doc, "one\ntwo\n");

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("saving before the buffer debounce fires still folds the edit into the baseline", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();

  const doc = open("a.ts", "one\ntwo\n");
  await saveWithoutBufferChange(doc, "one\nTWO\n");

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\nTWO\n",
    hadBom: false,
  });

  // The debounced buffer change and the disk write both arrive late and must change nothing.
  await model.handleBufferChange(editor.asDocument(doc));
  await model.handleDiskWrite(uri("a.ts"));

  expect(model.files).toEqual([]);
});

test("saving before the buffer debounce fires does not swallow a pending external change", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();

  await write("a.ts", "one\ntwo\nthree\n");
  await model.handleDiskWrite(uri("a.ts"));
  expect(model.get(key("a.ts"))?.added).toBe(1);

  const doc = open("a.ts", "one\ntwo\nthree\n");
  await saveWithoutBufferChange(doc, "ONE\ntwo\nthree\n");

  const file = model.get(key("a.ts"));
  expect(file?.baselineText).toBe("ONE\ntwo\n");
  expect(file?.hunks).toHaveLength(1);
  expect(file?.hunks[0]?.currLines).toEqual(["three"]);
});

test("a review document never stands in for the file it is reviewing", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  editor.openDocument(fsPath("a.ts"), "not the file\n", false, "changelens-review");
  await write("a.ts", "one\ntwo\n");
  await model.handleDiskWrite(uri("a.ts"));

  expect(model.get(key("a.ts"))?.currentText).toBe("one\ntwo\n");
});

test("an unsaved buffer keeps a disk write from rewriting the model", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const doc = open("a.ts", "one\n");
  doc.isDirty = true;
  await write("a.ts", "from disk\n");
  await model.handleDiskWrite(uri("a.ts"));

  expect(model.files).toEqual([]);
});

// #endregion

// #region review actions

test("accepting a file adopts its current content as the baseline", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("a.ts", "one\ntwo\n");
  await model.handleDiskWrite(uri("a.ts"));
  await model.acceptFile(key("a.ts"));

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("accepting a deleted file drops it from the baseline", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));
  await model.acceptFile(key("a.ts"));

  expect(model.files).toEqual([]);
  expect(store.has(key("a.ts"))).toBe(false);
});

test("accepting one hunk leaves the other pending", async () => {
  await write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  await model.initialize();

  await write("a.ts", "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  await model.handleDiskWrite(uri("a.ts"));

  const before = model.get(key("a.ts"));
  expect(before?.hunks).toHaveLength(2);
  const first = must(before?.signatures[0], "the first block's signature");
  expect(await model.acceptHunk(key("a.ts"), first)).toBe(true);

  const after = model.get(key("a.ts"));
  expect(after?.hunks).toHaveLength(1);
  expect(after?.baselineText).toBe("ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
});

test("reverting one hunk restores the baseline lines in the buffer", async () => {
  await write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  await model.initialize();

  await write("a.ts", "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  await model.handleDiskWrite(uri("a.ts"));

  const signature = must(model.get(key("a.ts"))?.signatures[0], "the block's signature");
  expect(await model.revertHunk(key("a.ts"), signature)).toBe(true);

  const remaining = model.get(key("a.ts"));
  expect(remaining?.currentText).toBe("one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  expect(remaining?.hunks).toHaveLength(1);
});

test("reverting a hunk that only added a trailing newline removes it", async () => {
  await write("a.ts", "one\ntwo");
  await model.initialize();

  await write("a.ts", "one\ntwo\n");
  await model.handleDiskWrite(uri("a.ts"));
  const doc = open("a.ts", "one\ntwo\n");

  const signature = must(model.get(key("a.ts"))?.signatures[0], "the block's signature");
  expect(await model.revertHunk(key("a.ts"), signature)).toBe(true);

  // The hunk is the empty line a trailing newline creates, and an edit that starts at column
  // zero of that line covers nothing at all.
  expect(doc.getText()).toBe("one\ntwo");
  expect(model.files).toEqual([]);
});

test("reverting a hunk appended past the last line takes its separator with it", async () => {
  await write("a.ts", "one\ntwo");
  await model.initialize();

  await write("a.ts", "one\ntwo\nthree");
  await model.handleDiskWrite(uri("a.ts"));
  const doc = open("a.ts", "one\ntwo\nthree");

  const signature = must(model.get(key("a.ts"))?.signatures[0], "the block's signature");
  expect(await model.revertHunk(key("a.ts"), signature)).toBe(true);

  expect(doc.getText()).toBe("one\ntwo");
  expect(model.files).toEqual([]);
});

test("reverting a modified file restores the whole baseline", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();

  await write("a.ts", "changed\n");
  await model.handleDiskWrite(uri("a.ts"));
  expect(await model.revertFile(key("a.ts"))).toBe(true);

  expect(model.files).toEqual([]);
});

test("reverting an added file deletes it from disk", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("new.ts", "fresh\n");
  await model.handleDiskWrite(uri("new.ts"));
  expect(await model.revertFile(key("new.ts"))).toBe(true);

  expect(nodeFs.existsSync(fsPath("new.ts"))).toBe(false);
  expect(model.files).toEqual([]);
});

test("reverting an added file is refused when it no longer holds what was reviewed", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("new.ts", "fresh\n");
  await model.handleDiskWrite(uri("new.ts"));

  // Someone edited it after the diff was computed; deleting it now would take that with it.
  editor.openDocument(fsPath("new.ts"), "fresh and then some\n", true);
  expect(await model.revertFile(key("new.ts"))).toBe(false);
  expect(nodeFs.existsSync(fsPath("new.ts"))).toBe(true);
});

test("reverting a deleted file recreates it byte for byte", async () => {
  await fs.writeFile(fsPath("a.ts"), `﻿one\r\ntwo\r\n`, "utf8");
  await model.initialize();

  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));
  expect(model.get(key("a.ts"))?.baselineHadBom).toBe(true);
  expect(await model.revertFile(key("a.ts"))).toBe(true);

  expect(await readDisk("a.ts")).toBe(`﻿one\r\ntwo\r\n`);
  expect(model.files).toEqual([]);
});

test("a revert is refused when the buffer no longer matches what was reviewed", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("a.ts", "changed\n");
  await model.handleDiskWrite(uri("a.ts"));

  // The buffer moved on underneath the review, so the recorded hunk no longer describes it.
  editor.openDocument(fsPath("a.ts"), "changed again\n", true);
  expect(await model.revertFile(key("a.ts"))).toBe(false);
});

test("a block command for a file that is not pending is refused", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // A stale lens or a tree row that outlived its file resolves to a key nothing knows about, which
  // is a different miss from a signature that no longer matches.
  expect(await model.acceptHunk(key("gone.ts"), "any-signature")).toBe(false);
  expect(await model.revertHunk(key("gone.ts"), "any-signature")).toBe(false);
});

test("reverting one hunk is refused when the buffer no longer matches either", async () => {
  await write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  await model.initialize();

  await write("a.ts", "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  await model.handleDiskWrite(uri("a.ts"));
  const signature = must(model.get(key("a.ts"))?.signatures[0], "the first block's signature");

  // A hunk revert writes at recorded line numbers, so a buffer that moved on is the one case where
  // it would overwrite lines nobody reviewed.
  editor.openDocument(fsPath("a.ts"), "something else entirely\n", true);
  expect(await model.revertHunk(key("a.ts"), signature)).toBe(false);
});

test("accepting everything clears the review", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();

  await write("a.ts", "one changed\n");
  await write("b.ts", "two changed\n");
  await model.handleDiskWrite(uri("a.ts"));
  await model.handleDiskWrite(uri("b.ts"));
  await model.acceptAll();

  expect(model.files).toEqual([]);
});

test("accepting everything notifies and persists once, not once per file", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();

  await write("a.ts", "one changed\n");
  await write("b.ts", "two changed\n");
  await model.handleDiskWrite(uri("a.ts"));
  await model.handleDiskWrite(uri("b.ts"));

  const flush = vi.spyOn(store, "flush");
  let notifications = 0;
  const subscription = model.onDidChange(() => {
    notifications += 1;
  });
  await model.acceptAll();
  subscription.dispose();

  expect(model.files).toEqual([]);
  expect(notifications).toBe(1);
  expect(flush).toHaveBeenCalledTimes(1);
});

// #endregion

// #region file operations from the editor

test("a file the user creates is adopted, not reported as an agent's addition", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("mine.ts", "written by the user\n");
  await model.handleEditorCreate([uri("mine.ts")]);

  expect(model.files).toEqual([]);
  expect(store.has(key("mine.ts"))).toBe(true);
});

test("a folder the user pastes in is adopted with everything in it", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // Pasting a folder arrives as one event for the folder, never one per file inside it.
  await fs.mkdir(fsPath(path.join("pasted", "deep")), { recursive: true });
  await write(path.join("pasted", "x.ts"), "pasted\n");
  await write(path.join("pasted", "deep", "y.ts"), "deeper\n");
  await model.handleEditorCreate([uri("pasted")]);

  expect(model.files).toEqual([]);
  expect(store.has(key(path.join("pasted", "x.ts")))).toBe(true);
  expect(store.has(key(path.join("pasted", "deep", "y.ts")))).toBe(true);
});

test("a file the user deletes is forgotten, not reported as a deletion", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await fs.rm(fsPath("a.ts"));
  await model.handleEditorDelete([uri("a.ts")]);

  expect(model.files).toEqual([]);
  expect(store.has(key("a.ts"))).toBe(false);
});

test("renaming a folder carries the baselines of everything inside it", async () => {
  await fs.mkdir(fsPath("src"), { recursive: true });
  await write(path.join("src", "a.ts"), "one\n");
  await write(path.join("src", "b.ts"), "two\n");
  await model.initialize();

  await write(path.join("src", "a.ts"), "one\nchanged\n");
  await model.handleDiskWrite(uri(path.join("src", "a.ts")));

  // VS Code reports a folder rename as one event for the folder, never one per file.
  await fs.rename(fsPath("src"), fsPath("lib"));
  await model.handleEditorRename([{ oldUri: uri("src"), newUri: uri("lib") }]);

  expect(store.has(key(path.join("src", "a.ts")))).toBe(false);
  expect(store.has(key(path.join("lib", "b.ts")))).toBe(true);
  const moved = model.get(key(path.join("lib", "a.ts")));
  expect(moved?.status).toBe("modified");
  expect(moved?.baselineText).toBe("one\n");
  expect(model.get(key(path.join("src", "a.ts")))).toBeUndefined();
});

test("deleting a folder forgets everything inside it", async () => {
  await fs.mkdir(fsPath("src"), { recursive: true });
  await write(path.join("src", "a.ts"), "one\n");
  await write(path.join("src", "b.ts"), "two\n");
  await model.initialize();

  await fs.rm(fsPath("src"), { recursive: true });
  await model.handleEditorDelete([uri("src")]);

  expect(store.size).toBe(0);
  expect(model.files).toEqual([]);
});

test("a folder deleted outside the editor reports every file it took with it", async () => {
  await fs.mkdir(fsPath(path.join("src", "deep")), { recursive: true });
  await write(path.join("src", "a.ts"), "one\n");
  await write(path.join("src", "deep", "b.ts"), "two\n");
  await model.initialize();

  // A folder deletion can arrive as one event for the folder, with none for the files inside.
  await fs.rm(fsPath("src"), { recursive: true });
  await model.handleDiskDelete(uri("src"));

  expect(model.get(key(path.join("src", "a.ts")))?.status).toBe("deleted");
  expect(model.get(key(path.join("src", "deep", "b.ts")))?.status).toBe("deleted");
});

test("a deleted folder that was never tracked does not walk the baseline", async () => {
  editor.state.configuration.set("changelens.exclude", ["vendor/**"]);
  await fs.mkdir(fsPath("vendor"), { recursive: true });
  await write("a.ts", "one\n");
  await model.initialize();

  const walked = vi.spyOn(store, "keys");
  await fs.rm(fsPath("vendor"), { recursive: true });
  await model.handleDiskDelete(uri("vendor"));

  // The scope check has to come first, or every delete event would scan the whole baseline.
  expect(walked).not.toHaveBeenCalled();
  expect(model.files).toEqual([]);
  expect(store.has(key("a.ts"))).toBe(true);
});

test("a folder whose reported size passes the limit is still expanded, not reviewed", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 1);
  await write("a.ts", "one\n");
  await model.initialize();

  await fs.mkdir(fsPath("dropped"), { recursive: true });
  await write(path.join("dropped", "one.ts"), "fresh\n");

  // A filesystem reports a size for the directory itself, unrelated to any file inside it.
  vi.spyOn(editor.workspace.fs, "stat").mockImplementation(async (target) => {
    const stat = await nodeFs.promises.stat(target.fsPath);
    const directory = stat.isDirectory();
    return {
      type: directory ? editor.FileType.Directory : editor.FileType.File,
      ctime: stat.birthtimeMs,
      mtime: stat.mtimeMs,
      size: directory ? 64 * 1024 : stat.size,
    };
  });
  await model.handleDiskWrite(uri("dropped"));

  expect(model.get(key("dropped"))).toBeUndefined();
  expect(model.get(key(path.join("dropped", "one.ts")))?.status).toBe("added");
});

test("a folder that arrives outside the editor reviews everything inside it", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await fs.mkdir(fsPath(path.join("dropped", "deep")), { recursive: true });
  await write(path.join("dropped", "one.ts"), "fresh\n");
  await write(path.join("dropped", "deep", "two.ts"), "also fresh\n");
  // An external move reports the folder, not the files it carried in.
  await model.handleDiskWrite(uri("dropped"));

  expect(model.get(key(path.join("dropped", "one.ts")))?.status).toBe("added");
  expect(model.get(key(path.join("dropped", "deep", "two.ts")))?.status).toBe("added");
});

test("a rename carries the baseline and any pending change to the new path", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("a.ts", "one\ntwo\n");
  await model.handleDiskWrite(uri("a.ts"));

  await fs.rename(fsPath("a.ts"), fsPath("b.ts"));
  await model.handleEditorRename([{ oldUri: uri("a.ts"), newUri: uri("b.ts") }]);

  expect(model.get(key("a.ts"))).toBeUndefined();
  expect(store.has(key("a.ts"))).toBe(false);
  const moved = model.get(key("b.ts"));
  expect(moved?.status).toBe("modified");
  expect(moved?.baselineText).toBe("one\n");
});

test("a rename waits for a buffer edit that is still rebasing the old path", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const doc = open("a.ts", "one\ntwo\n");

  // Park the buffer edit inside its rebase, where it holds the old path and is about to write
  // the rebased baseline back to it.
  const held = deferred();
  const readBaseline = store.readBaseline.bind(store);
  let parked = 1;
  vi.spyOn(store, "readBaseline").mockImplementation(async (target) => {
    const result = await readBaseline(target);
    if (parked > 0) {
      parked -= 1;
      await held.promise;
    }
    return result;
  });

  doc.setText("ONE\ntwo\n");
  doc.isDirty = true;
  const typing = model.handleBufferChange(editor.asDocument(doc));

  await fs.rename(fsPath("a.ts"), fsPath("b.ts"));
  const renaming = model.handleEditorRename([{ oldUri: uri("a.ts"), newUri: uri("b.ts") }]);

  held.resolve();
  await Promise.all([typing, renaming]);
  await model.drain();

  // Unqueued, the rename would carry the pre-rebase baseline across and the parked write would
  // then recreate the old key, leaving a file nobody can see reported as deleted.
  expect(store.has(key("a.ts"))).toBe(false);
  expect(await store.readBaseline(key("b.ts"))).toEqual({
    kind: "text",
    text: "ONE\ntwo\n",
    hadBom: false,
  });
});

test("a rename still in flight is covered by drain, past the first file it reaches", async () => {
  await write(path.join("src", "a.ts"), "one\n");
  await write(path.join("src", "b.ts"), "two\n");
  await model.initialize();

  await write(path.join("src", "a.ts"), "one\nmore\n");
  await write(path.join("src", "b.ts"), "two\nmore\n");
  await model.handleDiskWrite(uri(path.join("src", "a.ts")));
  await model.handleDiskWrite(uri(path.join("src", "b.ts")));

  // Shutdown flushes the store behind `drain`, so the whole walk has to be finished by the time
  // it returns. Waiting only on the per-file queues would settle after the first file.
  await fs.rename(fsPath("src"), fsPath("lib"));
  const renaming = model.handleEditorRename([{ oldUri: uri("src"), newUri: uri("lib") }]);
  await model.drain();

  expect(model.get(key(path.join("lib", "a.ts")))?.added).toBe(1);
  expect(model.get(key(path.join("lib", "b.ts")))?.added).toBe(1);
  await renaming;
});

test("renaming a file into scope adopts it instead of reporting an addition", async () => {
  editor.state.configuration.set("changelens.exclude", ["notes.bak"]);
  await write("a.ts", "one\n");
  await write("notes.bak", "written by the user\n");
  await model.initialize();
  expect(store.has(key("notes.bak"))).toBe(false);

  await fs.rename(fsPath("notes.bak"), fsPath("notes.ts"));
  await model.handleEditorRename([{ oldUri: uri("notes.bak"), newUri: uri("notes.ts") }]);

  expect(model.files).toEqual([]);
  expect(store.has(key("notes.ts"))).toBe(true);
});

test("renaming a folder into scope adopts everything inside it", async () => {
  editor.state.configuration.set("changelens.exclude", ["vendor"]);
  await write("a.ts", "one\n");
  await fs.mkdir(fsPath(path.join("vendor", "deep")), { recursive: true });
  await write(path.join("vendor", "x.ts"), "vendored\n");
  await write(path.join("vendor", "deep", "y.ts"), "deeper\n");
  await model.initialize();
  expect(store.has(key(path.join("vendor", "x.ts")))).toBe(false);

  await fs.rename(fsPath("vendor"), fsPath("lib"));
  await model.handleEditorRename([{ oldUri: uri("vendor"), newUri: uri("lib") }]);

  expect(model.files).toEqual([]);
  expect(store.has(key(path.join("lib", "x.ts")))).toBe(true);
  expect(store.has(key(path.join("lib", "deep", "y.ts")))).toBe(true);
});

test("a rename that brings part of a folder into scope leaves the tracked part alone", async () => {
  editor.state.configuration.set("changelens.exclude", ["src/vendor/**"]);
  await fs.mkdir(fsPath(path.join("src", "vendor")), { recursive: true });
  await write(path.join("src", "a.ts"), "one\n");
  await write(path.join("src", "vendor", "x.ts"), "vendored\n");
  await model.initialize();
  expect(store.has(key(path.join("src", "vendor", "x.ts")))).toBe(false);

  await write(path.join("src", "a.ts"), "one\nchanged\n");
  await model.handleDiskWrite(uri(path.join("src", "a.ts")));

  // Only the vendored file arrives without a baseline, so only it may be adopted. Adopting the
  // whole destination would take the pending change with it.
  await fs.rename(fsPath("src"), fsPath("lib"));
  await model.handleEditorRename([{ oldUri: uri("src"), newUri: uri("lib") }]);

  const moved = model.get(key(path.join("lib", "a.ts")));
  expect(moved?.status).toBe("modified");
  expect(moved?.baselineText).toBe("one\n");
  expect(store.has(key(path.join("lib", "vendor", "x.ts")))).toBe(true);
  expect(model.files).toHaveLength(1);
});

test("a rename that overwrites a tracked file is reported, not adopted", async () => {
  editor.state.configuration.set("changelens.exclude", ["notes.bak"]);
  await write("b.ts", "one\n");
  await write("notes.bak", "replacement\n");
  await model.initialize();

  // The source never had a baseline, but the destination did. Adopting here would accept the
  // overwrite silently, and whatever was pending on the destination would go with it.
  await fs.rename(fsPath("notes.bak"), fsPath("b.ts"));
  await model.handleEditorRename([{ oldUri: uri("notes.bak"), newUri: uri("b.ts") }]);

  const overwritten = model.get(key("b.ts"));
  expect(overwritten?.status).toBe("modified");
  expect(overwritten?.baselineText).toBe("one\n");
  expect(overwritten?.currentText).toBe("replacement\n");
});

test("a rename whose destination is gone again still reports the deletion", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await fs.rename(fsPath("a.ts"), fsPath("b.ts"));
  await fs.rm(fsPath("b.ts"));
  await model.handleEditorRename([{ oldUri: uri("a.ts"), newUri: uri("b.ts") }]);

  expect(model.get(key("b.ts"))?.status).toBe("deleted");
});

// #endregion

// #region capture races

test("a file created while the baseline is being captured is not lost", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  // The listing is already done, so this file cannot be part of the new baseline.
  await write("late.ts", "arrived late\n");
  const parked = model.handleDiskWrite(uri("late.ts"));
  gate.release();
  await capture;
  await parked;

  expect(model.get(key("late.ts"))?.status).toBe("added");
});

test("a file the user creates while capturing is adopted rather than replayed as a change", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  await write("mine.ts", "written by the user\n");
  const parked = model.handleEditorCreate([uri("mine.ts")]);
  gate.release();
  await capture;
  await parked;

  expect(model.files).toEqual([]);
  expect(store.has(key("mine.ts"))).toBe(true);
});

test("a folder renamed during a capture keeps the baselines of its contents", async () => {
  await fs.mkdir(fsPath("src"), { recursive: true });
  await write(path.join("src", "a.ts"), "one\n");
  await model.initialize();

  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  // Lands after the listing, so nothing inside the new folder can be part of the new baseline.
  await fs.rename(fsPath("src"), fsPath("lib"));
  const parked = model.handleEditorRename([{ oldUri: uri("src"), newUri: uri("lib") }]);
  gate.release();
  await capture;
  await parked;

  expect(store.has(key(path.join("lib", "a.ts")))).toBe(true);
  expect(model.files).toEqual([]);
});

test("a rename during a capture parks both sides, so the destination keeps a baseline", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  // The rename lands after the listing: the old path is gone and the new one was never seen.
  await fs.rename(fsPath("a.ts"), fsPath("b.ts"));
  const parked = model.handleEditorRename([{ oldUri: uri("a.ts"), newUri: uri("b.ts") }]);
  gate.release();
  await capture;
  await parked;

  expect(store.has(key("a.ts"))).toBe(false);
  expect(store.has(key("b.ts"))).toBe(true);
  expect(model.files).toEqual([]);
});

test("a capture that fails leaves no half-baseline and still replays what it missed", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  vi.spyOn(store, "setText").mockImplementationOnce(() => Promise.reject(new Error("disk full")));
  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  await write("late.ts", "arrived late\n");
  const parked = model.handleDiskWrite(uri("late.ts"));
  gate.release();

  await expect(capture).rejects.toThrow("disk full");
  await parked;

  // Uninitialized, so the next activation captures cleanly instead of reconciling against half
  // a workspace, and the parked event was not swallowed by the failure.
  expect(store.initialized).toBe(false);
  expect(model.get(key("late.ts"))?.status).toBe("added");
  expect(editor.state.shown.at(-1)?.message).toContain("could not finish resetting the baseline");
});

test("a failed lifecycle operation does not strand the ones queued behind it", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  vi.spyOn(store, "setText").mockImplementationOnce(() => Promise.reject(new Error("disk full")));
  const failing = model.captureBaseline(false);
  const queued = model.reconcile();

  await expect(failing).rejects.toThrow("disk full");
  // A chain left in a rejected state would skip this instead of running it.
  await queued;

  // The capture cleared the baseline before it failed, so the reconcile behind it has something
  // to find: a file with nothing to measure against.
  expect(model.get(key("a.ts"))?.status).toBe("added");
});

test("a failed first capture offers a reload, since a retry cannot finish activation", async () => {
  await write("a.ts", "one\n");
  vi.spyOn(store, "setText").mockImplementationOnce(() => Promise.reject(new Error("disk full")));

  await expect(model.initialize()).rejects.toThrow("disk full");

  // Activation stopped short of the watcher, so filling the store would leave nothing watching it.
  expect(model.ready).toBe(false);
  expect(editor.state.shown.at(-1)?.message).toContain("not tracking this window");
  expect(editor.state.shown.at(-1)?.items).toEqual(["Reload Window"]);
});

test("a retry that fails again announces itself and leaves the chain usable", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // One retry only, or every announcement would start another capture.
  let retries = 1;
  editor.state.answer = (_message, items) =>
    retries-- > 0 ? items.find((item) => item === "Try Again") : undefined;
  vi.spyOn(store, "setText").mockImplementation(() => Promise.reject(new Error("disk full")));

  await expect(model.captureBaseline(false)).rejects.toThrow("disk full");
  await model.drain();

  // Nobody awaits the retry, so a second failure has to speak for itself.
  expect(model.reviewable).toBe(false);
  expect(
    editor.state.shown.filter((shown) => shown.message.includes("could not finish")),
  ).toHaveLength(2);
  await expect(model.reconcile()).resolves.toBeUndefined();
});

test("the retry offered after a failed capture rebuilds the baseline", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  editor.state.answer = (_message, items) => items.find((item) => item === "Try Again");

  vi.spyOn(store, "setText").mockImplementationOnce(() => Promise.reject(new Error("disk full")));
  await expect(model.captureBaseline(false)).rejects.toThrow("disk full");

  // The dialog is answered outside the lifecycle chain, so the retry it starts has to be waited on.
  await model.drain();

  expect(store.initialized).toBe(true);
  expect(store.has(key("a.ts"))).toBe(true);
});

test("a file the user deletes while capturing does not come back as an addition", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  await fs.rm(fsPath("a.ts"));
  const parked = model.handleEditorDelete([uri("a.ts")]);
  gate.release();
  await capture;
  await parked;

  expect(store.has(key("a.ts"))).toBe(false);
  expect(model.files).toEqual([]);
});

test("two captures started together run one after the other", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // Deferral is a single shared map, so an overlap would let the first capture to finish switch
  // deferral off while the second is still rebuilding the baseline.
  let active = 0;
  let overlapped = false;
  const original = editor.window.withProgress.bind(editor.window);
  vi.spyOn(editor.window, "withProgress").mockImplementation(async (options, task) => {
    active += 1;
    overlapped ||= active > 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await original(options, task);
    active -= 1;
    return result;
  });

  await Promise.all([model.captureBaseline(false), model.captureBaseline(false)]);

  expect(overlapped).toBe(false);
  expect(model.files).toEqual([]);
});

test("drain waits for an accept that is still in flight", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await write("a.ts", "two\n");
  await model.handleDiskWrite(uri("a.ts"));

  // Shutdown flushes the store behind drain, so an accept that has not reached it yet would be
  // written over by whatever the flush found instead.
  const held = deferred();
  const setText = store.setText.bind(store);
  vi.spyOn(store, "setText").mockImplementation(async (target, text, hadBom) => {
    await held.promise;
    await setText(target, text, hadBom);
  });

  const accept = model.acceptFile(key("a.ts"));
  const drained = model.drain();
  held.resolve();
  await drained;

  expect(model.files).toEqual([]);
  await accept;
});

test("an event during a filter rebuild is judged by the filter that is still in force", async () => {
  await write(".gitignore", "*.log\n");
  await write("a.ts", "one\n");
  await model.initialize();

  const gate = holdGitignoreRead();
  const reloading = model.reloadConfig();
  await gate.entered;

  // Nothing parks file events for a config change, so this lands while the filter is rebuilding.
  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(uri("a.ts"));

  gate.release();
  await reloading;

  expect(model.get(key("a.ts"))?.status).toBe("deleted");
});

test("a filter rebuild does not publish the new settings before the patterns they came with", async () => {
  await write(".gitignore", "*.log\n");
  await model.initialize();
  editor.state.configuration.set("changelens.maxFileSizeKb", 1);

  const gate = holdGitignoreRead();
  const reloading = model.reloadConfig();
  await gate.entered;

  expect(model.config.maxFileSizeKb).toBe(512);

  gate.release();
  await reloading;

  expect(model.config.maxFileSizeKb).toBe(1);
});

test("a toggle made during a filter rebuild is not undone by the snapshot it interrupted", async () => {
  await write(".gitignore", "*.log\n");
  await model.initialize();

  const gate = holdGitignoreRead();
  const reloading = model.reloadConfig();
  await gate.entered;

  // Stored toggles raise no configuration event, so nothing would come back to correct this.
  await model.setViewMode("list");
  await model.toggleReviewMode();

  gate.release();
  await reloading;

  expect(model.config.viewMode).toBe("list");
  expect(model.config.reviewMode).toBe("diffEditor");
});

test("a folder deleted while events are deferred reports its files once they are replayed", async () => {
  await fs.mkdir(fsPath("src"), { recursive: true });
  await write(path.join("src", "a.ts"), "one\n");
  await model.initialize();

  const gate = holdAbsorb();
  const absorb = model.absorbGitRewrite([uri(path.join("src", "a.ts"))], new Map());
  await gate.entered;

  await fs.rm(fsPath("src"), { recursive: true });
  const parked = model.handleDiskDelete(uri("src"));
  gate.release();
  await absorb;
  await parked;
  await model.drain();

  expect(model.get(key(path.join("src", "a.ts")))?.status).toBe("deleted");
});

test("a folder that arrives while events are deferred is reviewed once it is replayed", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const gate = holdAbsorb();
  const absorb = model.absorbGitRewrite([uri("a.ts")], new Map());
  await gate.entered;

  // One event for the folder, none for what it brought with it.
  await fs.mkdir(fsPath("src"), { recursive: true });
  await write(path.join("src", "b.ts"), "two\n");
  const parked = model.handleDiskWrite(uri("src"));
  gate.release();
  await absorb;
  await parked;
  await model.drain();

  expect(model.get(key(path.join("src", "b.ts")))?.status).toBe("added");
});

test("a file deleted while events are deferred is not kept deleted by an identical recreation", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const gate = holdAbsorb();
  const absorb = model.absorbGitRewrite([uri("a.ts")], new Map());
  await gate.entered;

  await fs.rm(fsPath("a.ts"));
  const parked = model.handleDiskDelete(uri("a.ts"));
  gate.release();
  await absorb;
  await parked;
  expect(model.get(key("a.ts"))?.status).toBe("deleted");

  // The same bytes come back; the last disk reading must not make this look like a no-op.
  await write("a.ts", "one\n");
  await model.handleDiskWrite(uri("a.ts"));
  expect(model.files).toEqual([]);
});

// #endregion

// #region reconcile

test("reconcile trusts a clean stat but a refresh does not", async () => {
  const stamp = new Date(Date.now() - 60_000);
  await write("a.ts", "one\n");
  await fs.utimes(fsPath("a.ts"), stamp, stamp);
  await model.initialize();

  // A write the watcher never reported. Same length, and stamped back to the same instant, so
  // the recorded clean stat still matches and only a real comparison can find the change.
  await fs.writeFile(fsPath("a.ts"), "ONE\n", "utf8");
  await fs.utimes(fsPath("a.ts"), stamp, stamp);

  await model.reconcile();
  expect(model.files).toEqual([]);

  await model.reconcile(false);
  expect(model.get(key("a.ts"))?.status).toBe("modified");
});

test("a write landing while a refresh reads the file is not hidden by the stale reading", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // The refresh has read the old bytes and not yet derived from them when the write lands.
  const entered = deferred();
  const held = deferred();
  const original = editor.workspace.fs.readFile.bind(editor.workspace.fs);
  let holdNext = true;
  vi.spyOn(editor.workspace.fs, "readFile").mockImplementation(async (target) => {
    const bytes = await original(target);
    if (holdNext && target.fsPath.endsWith("a.ts")) {
      holdNext = false;
      entered.resolve();
      await held.promise;
    }
    return bytes;
  });

  const refresh = model.reconcile(false);
  await entered.promise;
  await write("a.ts", "one\nagent\n");
  const event = model.handleDiskWrite(uri("a.ts"));
  // Give the event every chance to run ahead of the held derivation; queued correctly it cannot,
  // and only then is the stale reading released.
  await Promise.race([event, new Promise((resolve) => setTimeout(resolve, 200))]);
  held.resolve();
  await Promise.all([refresh, event]);

  expect(model.get(key("a.ts"))?.hunks.map((hunk) => hunk.currLines)).toEqual([["agent"]]);
});

test("a file brought into scope by a settings change is baselined, not reported", async () => {
  editor.state.configuration.set("changelens.exclude", ["generated"]);
  await fs.mkdir(fsPath("generated"), { recursive: true });
  await write(path.join("generated", "g.ts"), "generated\n");
  await write("a.ts", "one\n");
  await model.initialize();
  expect(store.size).toBe(1);

  editor.state.configuration.set("changelens.exclude", []);
  await model.rescope();

  expect(model.files).toEqual([]);
  expect(store.has(key(path.join("generated", "g.ts")))).toBe(true);
});

test("a rescope that crosses the tracked-file limit warns, and says so only once", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  editor.state.configuration.set("changelens.exclude", ["b.ts"]);
  editor.state.configuration.set("changelens.maxTrackedFiles", 1);
  await model.initialize();

  // One file in scope is still within the limit, so the capture has nothing to report.
  expect(editor.state.shown).toEqual([]);

  editor.state.configuration.set("changelens.exclude", []);
  await model.rescope();
  await model.rescope();

  expect(editor.state.shown).toHaveLength(1);
  expect(editor.state.shown[0]?.kind).toBe("warning");
  expect(editor.state.shown[0]?.message).toContain("tracking 2 files");
  expect(editor.state.shown[0]?.message).toContain("limit of 1");
});

test("a rescope counts the baselines it retained, not only the files it listed", async () => {
  await fs.mkdir(fsPath("legacy"), { recursive: true });
  await write(path.join("legacy", "a.ts"), "one\n");
  await write(path.join("legacy", "b.ts"), "two\n");
  editor.state.configuration.set("changelens.maxTrackedFiles", 2);
  await model.initialize();
  expect(store.size).toBe(2);
  expect(editor.state.shown).toEqual([]);

  // Excluding a folder keeps its baselines, so the listing sees one file while three are stored.
  await write("c.ts", "three\n");
  editor.state.configuration.set("changelens.exclude", ["legacy/**"]);
  await model.rescope();

  expect(store.size).toBe(3);
  expect(editor.state.shown.at(-1)?.message).toContain("tracking 3 files");
});

test("lowering the tracked-file limit warns without anything else changing", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  expect(editor.state.shown).toEqual([]);

  editor.state.configuration.set("changelens.maxTrackedFiles", 1);
  await model.reloadConfig();

  expect(editor.state.shown.at(-1)?.message).toContain("tracking 2 files");
});

test("a baseline already over the limit warns when the window opens again", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  await store.flush();
  expect(editor.state.shown).toEqual([]);

  // A second window over the same storage loads the baseline whole, with no root arriving.
  model.dispose();
  editor.state.shown = [];
  editor.state.configuration.set("changelens.maxTrackedFiles", 1);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
  await model.initialize();

  expect(editor.state.shown.at(-1)?.message).toContain("tracking 2 files");
});

test("adopting a created folder warns when it pushes the baseline over the limit", async () => {
  await write("a.ts", "one\n");
  editor.state.configuration.set("changelens.maxTrackedFiles", 2);
  await model.initialize();
  expect(editor.state.shown).toEqual([]);

  await fs.mkdir(fsPath("added"), { recursive: true });
  await write(path.join("added", "b.ts"), "two\n");
  await write(path.join("added", "c.ts"), "three\n");
  await model.handleEditorCreate([uri("added")]);

  expect(editor.state.shown.at(-1)?.message).toContain("tracking 3 files");
});

test("a create parked by a capture warns when the replay finally adopts it", async () => {
  await write("a.ts", "one\n");
  editor.state.configuration.set("changelens.maxTrackedFiles", 1);
  await model.initialize();

  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  // Parked here, so the handler returns while the baseline still holds one file.
  await write("mine.ts", "written by the user\n");
  const parked = model.handleEditorCreate([uri("mine.ts")]);
  gate.release();
  await capture;
  await parked;

  expect(editor.state.shown.at(-1)?.message).toContain("tracking 2 files");
});

test("a rename that adopts its destination warns when it crosses the limit", async () => {
  editor.state.configuration.set("changelens.exclude", ["notes.bak"]);
  editor.state.configuration.set("changelens.maxTrackedFiles", 1);
  await write("a.ts", "one\n");
  await write("notes.bak", "written by the user\n");
  await model.initialize();
  expect(editor.state.shown).toEqual([]);

  await fs.rename(fsPath("notes.bak"), fsPath("notes.ts"));
  await model.handleEditorRename([{ oldUri: uri("notes.bak"), newUri: uri("notes.ts") }]);

  expect(editor.state.shown.at(-1)?.message).toContain("tracking 2 files");
});

test("accepting an added file warns when it crosses the limit", async () => {
  await write("a.ts", "one\n");
  editor.state.configuration.set("changelens.maxTrackedFiles", 1);
  await model.initialize();

  await write("new.ts", "fresh\n");
  await model.handleDiskWrite(uri("new.ts"));

  // A pending addition is not in the baseline, which is what the limit counts.
  expect(editor.state.shown).toEqual([]);

  await model.acceptFile(key("new.ts"));

  expect(editor.state.shown.at(-1)?.message).toContain("tracking 2 files");
});

test("a workspace folder the index does not know is baselined, not reported", async () => {
  const second = path.join(root, "second");
  await fs.mkdir(second, { recursive: true });
  await write("a.ts", "one\n");
  await fs.writeFile(path.join(second, "b.ts"), "two\n", "utf8");
  editor.setWorkspaceFolders([workspace, second]);
  await model.initialize();
  expect(store.size).toBe(2);

  // Between sessions the second folder is replaced and the first is edited externally.
  await write("a.ts", "one changed\n");
  const third = path.join(root, "third");
  await fs.mkdir(third, { recursive: true });
  await fs.writeFile(path.join(third, "c.ts"), "three\n", "utf8");
  editor.setWorkspaceFolders([workspace, third]);

  const reloadedStore = new BaselineStore(path.join(root, "state"));
  const reloaded = new ChangeModel(reloadedStore);
  await reloaded.initialize();

  // The folder that stayed keeps its baseline, so the edit is still reviewable.
  expect(reloaded.get(key("a.ts"))?.status).toBe("modified");
  expect(reloaded.files).toHaveLength(1);
  // The newcomer is taken as it is; nobody changed those files.
  expect(reloadedStore.has(normalizeKey(path.join(third, "c.ts")))).toBe(true);
  expect(reloadedStore.has(normalizeKey(path.join(second, "b.ts")))).toBe(false);

  reloaded.dispose();
  await reloadedStore.flush();
});

test("closing a workspace folder during a session drops its baselines", async () => {
  const second = path.join(root, "second");
  await fs.mkdir(second, { recursive: true });
  await write("a.ts", "one\n");
  await fs.writeFile(path.join(second, "b.ts"), "two\n", "utf8");
  editor.setWorkspaceFolders([workspace, second]);
  await model.initialize();
  expect(store.size).toBe(2);

  editor.setWorkspaceFolders([workspace]);
  await model.rescope();

  // Unlike an exclude pattern, a closed folder is gone: keeping its baseline would resurrect it
  // whenever the folder came back, however long it had been edited elsewhere in the meantime.
  expect(store.has(normalizeKey(path.join(second, "b.ts")))).toBe(false);
  expect(store.size).toBe(1);
  expect(model.files).toEqual([]);
});

test("a workspace folder closed during a capture cannot rewrite the roots underneath it", async () => {
  const second = path.join(root, "second");
  await fs.mkdir(second, { recursive: true });
  await write("a.ts", "one\n");
  await fs.writeFile(path.join(second, "b.ts"), "two\n", "utf8");
  editor.setWorkspaceFolders([workspace, second]);
  await model.initialize();

  const gate = holdCapture();
  const capture = model.captureBaseline(false);
  await gate.entered;

  // The capture has already listed both folders. A rescope running beside it would drop the roots
  // it is still writing against, and every remaining file would be persisted as an absolute path
  // that outlives the folder.
  editor.setWorkspaceFolders([workspace]);
  const rescoping = model.rescope();
  gate.release();
  await Promise.all([capture, rescoping]);
  await store.flush();

  expect(store.has(normalizeKey(path.join(second, "b.ts")))).toBe(false);
  expect(store.has(key("a.ts"))).toBe(true);

  const index: unknown = JSON.parse(
    await fs.readFile(path.join(root, "state", "index.json"), "utf8"),
  );
  expect(JSON.stringify(index)).not.toContain(JSON.stringify(second).slice(1, -1));
});

test("a file taken out of scope leaves the review but keeps its baseline", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  await write("b.ts", "two changed\n");
  await model.handleDiskWrite(uri("b.ts"));
  expect(model.files).toHaveLength(1);

  editor.state.configuration.set("changelens.exclude", ["b.ts"]);
  await model.rescope();
  expect(model.files).toEqual([]);

  // Excluding and re-including must not have quietly accepted the change it hid.
  editor.state.configuration.set("changelens.exclude", []);
  await model.rescope();
  expect(model.get(key("b.ts"))?.baselineText).toBe("two\n");
});

test("draining settles work that is already under way", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await write("a.ts", "one\ntwo\n");
  const inFlight = model.handleDiskWrite(uri("a.ts"));
  await model.drain();

  expect(model.get(key("a.ts"))?.status).toBe("modified");
  await inFlight;
});

test("a restart re-derives the pending changes from the stored baseline", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await write("a.ts", "one\ntwo\n");
  await model.handleDiskWrite(uri("a.ts"));
  await store.flush();
  model.dispose();

  const reopened = new BaselineStore(path.join(root, "state"));
  const restarted = new ChangeModel(reopened);
  await restarted.initialize();

  expect(restarted.get(key("a.ts"))?.status).toBe("modified");
  expect(restarted.get(key("a.ts"))?.baselineText).toBe("one\n");
  restarted.dispose();
  await reopened.flush();
});

// #endregion

// #region files without a diff

test("a binary file is tracked by its stat, and a change to it is reported without a diff", async () => {
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await model.initialize();
  expect(model.files).toEqual([]);

  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03]));
  await model.handleDiskWrite(uri("logo.png"));

  const file = model.get(key("logo.png"));
  expect(file?.status).toBe("modified");
  expect(file?.opaqueReason).toBe("binary");
  expect(file?.hunks).toEqual([]);
  expect(file?.unified).toBeNull();
});

test("a modified file tracked without content refuses both kinds of revert", async () => {
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await model.initialize();

  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03]));
  await model.handleDiskWrite(uri("logo.png"));

  // There is no stored content to put back, so both paths have to refuse before touching the file
  // rather than restore an empty one. The command layer warns; the model just says no.
  expect(await model.revertFile(key("logo.png"))).toBe(false);
  // A contentless file has no blocks at all, so any signature is as wrong as the next.
  expect(await model.revertHunk(key("logo.png"), "any-signature")).toBe(false);
  expect(await fs.readFile(fsPath("logo.png"))).toEqual(
    Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03]),
  );
});

test("reverting an added binary file deletes it", async () => {
  await model.initialize();
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await model.handleDiskWrite(uri("logo.png"));

  expect(model.get(key("logo.png"))?.status).toBe("added");
  expect(model.get(key("logo.png"))?.opaqueReason).toBe("binary");
  expect(await model.revertFile(key("logo.png"))).toBe(true);

  expect(nodeFs.existsSync(fsPath("logo.png"))).toBe(false);
  expect(model.files).toEqual([]);
});

test("reverting an added binary file is refused when its disk state moved on", async () => {
  await model.initialize();
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await model.handleDiskWrite(uri("logo.png"));

  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x02, 0x03]));
  expect(await model.revertFile(key("logo.png"))).toBe(false);

  expect(nodeFs.existsSync(fsPath("logo.png"))).toBe(true);
  expect(model.get(key("logo.png"))).toBeDefined();
});

test("a deleted binary file keeps the reason its baseline recorded", async () => {
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await model.initialize();

  await fs.rm(fsPath("logo.png"));
  await model.handleDiskDelete(uri("logo.png"));

  const file = model.get(key("logo.png"));
  expect(file?.status).toBe("deleted");
  // Not `lostBaseline`: the baseline is intact and says why it never held content.
  expect(file?.opaqueReason).toBe("binary");
});

test("a file above the size limit is tracked without content", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("huge.log", "x".repeat(200));
  await model.initialize();

  expect(store.entry(key("huge.log"))?.kind).toBe("opaque");
  expect(model.files).toEqual([]);

  await write("huge.log", "y".repeat(300));
  await model.handleDiskWrite(uri("huge.log"));
  expect(model.get(key("huge.log"))?.opaqueReason).toBe("tooLarge");
});

test("an open buffer does not bring an oversized file back into content tracking", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("huge.log", "x".repeat(200));
  await model.initialize();

  // The buffer is the one source of text that carries no size with it.
  open("huge.log", "x".repeat(200));
  await model.recompute(uri("huge.log"));

  expect(model.files).toEqual([]);
});

test("an oversized file stays opaque even when its unsaved buffer is small", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("huge.log", "x".repeat(200));
  await model.initialize();

  // Editing it down does not make the file trackable: what is on disk is still over the limit,
  // and that is what would be stored the moment the buffer is saved.
  const doc = open("huge.log", "x".repeat(200));
  doc.setText("small");
  doc.isDirty = true;
  await model.recompute(uri("huge.log"));

  await model.acceptFile(key("huge.log"));
  expect(store.entry(key("huge.log"))?.kind).toBe("opaque");
});

test("a capture keeps an oversized unsaved buffer out of the baseline", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("a.ts", "one\n");
  await model.initialize();

  // The file on disk is small, so nothing before the capture would have called it oversized.
  const doc = open("a.ts", "one\n");
  doc.setText("y".repeat(300));
  doc.isDirty = true;
  await model.captureBaseline(false);

  expect(store.entry(key("a.ts"))?.kind).toBe("opaque");
});

test("accepting a file whose baseline was lost starts tracking it from its current state", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await store.flush();

  await fs.rm(path.join(root, "state", "blobs"), { recursive: true, force: true });
  const reopened = new BaselineStore(path.join(root, "state"));
  const restarted = new ChangeModel(reopened);
  await restarted.initialize();
  await restarted.recompute(uri("a.ts"));
  expect(restarted.get(key("a.ts"))?.opaqueReason).toBe("lostBaseline");

  // The refusal the command shows for this file points here: accepting is the way out, and it has
  // to store real content rather than carry the missing blob forward.
  await restarted.acceptFile(key("a.ts"));

  expect(restarted.files).toEqual([]);
  expect(await reopened.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: false,
  });
  restarted.dispose();
  await reopened.flush();
});

test("accepting a contentless file that vanished first drops it from the baseline", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("huge.log", "x".repeat(200));
  await model.initialize();

  await write("huge.log", "y".repeat(300));
  await model.handleDiskWrite(uri("huge.log"));
  expect(model.get(key("huge.log"))?.opaqueReason).toBe("tooLarge");

  // Deleted between the review and the accept, with no event for it yet. Storing the entry anyway
  // would leave a baseline for a file that is not there.
  await fs.rm(fsPath("huge.log"));
  await model.acceptFile(key("huge.log"));

  expect(store.has(key("huge.log"))).toBe(false);
  expect(model.files).toEqual([]);
});

test("accepting a file that cannot be read leaves its baseline alone", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await fs.rm(fsPath("a.ts"));
  await fs.mkdir(fsPath("a.ts"));
  await model.recompute(uri("a.ts"));
  expect(model.get(key("a.ts"))?.opaqueReason).toBe("unreadableFile");

  await model.acceptFile(key("a.ts"));

  // There is nothing to adopt, and the stored baseline is the only copy of the content left.
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: false,
  });
  expect(model.get(key("a.ts"))?.opaqueReason).toBe("unreadableFile");
});

test("accepting a file whose unsaved buffer is oversized stores no content", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("a.ts", "one\n");
  await model.initialize();

  const doc = open("a.ts", "one\n");
  doc.setText("y".repeat(300));
  doc.isDirty = true;
  await model.recompute(uri("a.ts"));

  await model.acceptFile(key("a.ts"));
  expect(store.entry(key("a.ts"))?.kind).toBe("opaque");
});

test("an editor edit that pushes a file over the limit is not folded into the baseline", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("a.ts", "one\n");
  await model.initialize();

  // Folding editor edits into the baseline is the third path a buffer takes to a stored blob.
  const doc = open("a.ts", "one\n");
  await type(doc, "y".repeat(300));

  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: false,
  });
});

test("a file the user has created but not saved is still compared as text", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // Nothing on disk to stat, so the buffer is the only version there is.
  const doc = editor.openDocument(fsPath("fresh.ts"), "unsaved\n", true);
  model.handleDocumentOpened(editor.asDocument(doc));
  await model.recompute(uri("fresh.ts"));

  expect(model.get(key("fresh.ts"))?.status).toBe("added");
  expect(model.get(key("fresh.ts"))?.currentText).toBe("unsaved\n");
});

test("accepting an oversized file keeps its content out of the baseline", async () => {
  editor.state.configuration.set("changelens.maxFileSizeKb", 0.01);
  await write("huge.log", "x".repeat(200));
  await model.initialize();

  await write("huge.log", "y".repeat(300));
  await model.handleDiskWrite(uri("huge.log"));
  open("huge.log", "y".repeat(300));
  expect(model.get(key("huge.log"))?.opaqueReason).toBe("tooLarge");

  await model.acceptFile(key("huge.log"));

  expect(store.entry(key("huge.log"))?.kind).toBe("opaque");
  expect(model.files).toEqual([]);
});

test("a file that cannot be read is reported as modified, never as deleted", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // A directory in the file's place stats fine and fails to read, like a lock or a denied ACL.
  await fs.rm(fsPath("a.ts"));
  await fs.mkdir(fsPath("a.ts"));
  await model.recompute(uri("a.ts"));

  const file = model.get(key("a.ts"));
  expect(file?.status).toBe("modified");
  expect(file?.opaqueReason).toBe("unreadableFile");
});

test("a deletion is still reported when the baseline blob is gone", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await store.flush();

  await fs.rm(path.join(root, "state", "blobs"), { recursive: true, force: true });
  const reopened = new BaselineStore(path.join(root, "state"));
  const restarted = new ChangeModel(reopened);
  await restarted.initialize();

  await fs.rm(fsPath("a.ts"));
  await restarted.handleDiskDelete(uri("a.ts"));

  const file = restarted.get(key("a.ts"));
  expect(file?.status).toBe("deleted");
  expect(file?.opaqueReason).toBe("lostBaseline");
  restarted.dispose();
  await reopened.flush();
});

// #endregion

// #region byte order mark

test("a file that only gains a byte order mark is folded in, not put up for review", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  await fs.writeFile(fsPath("a.ts"), `﻿one\n`, "utf8");
  await model.handleDiskWrite(uri("a.ts"));

  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\n",
    hadBom: true,
  });
});

test("the byte order mark stays out of the reviewed text", async () => {
  await fs.writeFile(fsPath("a.ts"), `﻿one\n`, "utf8");
  await model.initialize();

  await fs.writeFile(fsPath("a.ts"), `﻿one\ntwo\n`, "utf8");
  await model.handleDiskWrite(uri("a.ts"));

  const file = model.get(key("a.ts"));
  expect(file?.baselineText).toBe("one\n");
  expect(file?.currentText).toBe("one\ntwo\n");
  expect(file?.baselineHadBom).toBe(true);
  expect(file?.currentHadBom).toBe(true);
});

// #endregion
