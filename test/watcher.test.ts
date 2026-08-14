import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import { WorkspaceWatcher } from "../src/tracking/watcher";
import { must } from "./helpers/assert";
import { deferred } from "./helpers/async";
import * as editor from "./helpers/vscode";

/**
 * The watcher turns editor events into model calls, so these tests assert which call was made and
 * when, not what the model then did with it. Only `setTimeout` is faked, because the debounces are
 * the point.
 */

/**
 * The real lookup spawns Git with the temp workspace as its cwd, which on Windows then cannot be
 * removed while the child is alive. What it resolves to has its own test file; what matters here is
 * that a test can decide when it answers.
 */
const gitHead = vi.hoisted(() => ({
  resolve: (folder: string): Promise<string> => Promise.resolve(`${folder}/.git/HEAD`),
}));

vi.mock("../src/tracking/gitHead", () => ({
  resolveGitHead: (folder: string) => gitHead.resolve(folder),
}));

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;
let watcher: WorkspaceWatcher;
let errors: string[];
let headChanges: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-watcher-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
  errors = [];
  headChanges = 0;
  gitHead.resolve = (folder: string) => Promise.resolve(`${folder}/.git/HEAD`);
  watcher = new WorkspaceWatcher(model, () => void (headChanges += 1), {
    onError: (message) => errors.push(message),
  });
});

afterEach(async () => {
  watcher.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  model.dispose();
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

function uri(name: string) {
  return editor.Uri.file(path.join(workspace, name));
}

/** The workspace-wide watcher, which is the one every file event arrives on. */
function files(): editor.FileSystemWatcher {
  return must(editor.watchersFor("**/*").at(-1), "the workspace file watcher");
}

/** Lets every debounce shorter than `ms` fire and settles the work it started. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

test("a burst of writes to one file is collapsed into a single pass", async () => {
  const write = vi.spyOn(model, "handleDiskWrite").mockResolvedValue();
  watcher.activate();

  // An agent rewriting a file emits many events; treating each as a change would re-diff the file
  // over and over while it is still being written.
  for (let i = 0; i < 5; i++) {
    files().fire("change", uri("a.ts"));
    await advance(100);
  }
  await advance(200);

  expect(write).toHaveBeenCalledTimes(1);
});

test("writes to different files are not collapsed into one", async () => {
  const write = vi.spyOn(model, "handleDiskWrite").mockResolvedValue();
  watcher.activate();

  files().fire("change", uri("a.ts"));
  files().fire("change", uri("b.ts"));
  await advance(200);

  expect(write.mock.calls.map(([target]) => path.basename(target.fsPath))).toEqual([
    "a.ts",
    "b.ts",
  ]);
});

test("a create is treated as a write and a delete as a deletion", async () => {
  const write = vi.spyOn(model, "handleDiskWrite").mockResolvedValue();
  const remove = vi.spyOn(model, "handleDiskDelete").mockResolvedValue();
  watcher.activate();

  files().fire("create", uri("new.ts"));
  files().fire("delete", uri("gone.ts"));
  await advance(200);

  expect(write).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

test("a buffer edit is debounced longer than a disk write, and separately", async () => {
  const buffer = vi.spyOn(model, "handleBufferChange").mockResolvedValue();
  const write = vi.spyOn(model, "handleDiskWrite").mockResolvedValue();
  watcher.activate();

  const doc = editor.openDocument(path.join(workspace, "a.ts"), "one\n");
  editor.state.events.documentChanged.fire({ document: doc });
  files().fire("change", uri("a.ts"));

  // Typing settles later than the write it will eventually cause, and the two are keyed apart so
  // neither cancels the other.
  await advance(200);
  expect(write).toHaveBeenCalledTimes(1);
  expect(buffer).not.toHaveBeenCalled();

  await advance(300);
  expect(buffer).toHaveBeenCalledTimes(1);
});

test("a save is reported at once, without waiting for a debounce", () => {
  const save = vi.spyOn(model, "handleSave").mockResolvedValue();
  watcher.activate();

  const doc = editor.openDocument(path.join(workspace, "a.ts"), "one\n");
  editor.state.events.documentSaved.fire(doc);

  // Ctrl+S is a single deliberate act, not a burst, and the buffer text is already final.
  expect(save).toHaveBeenCalledTimes(1);
});

test("documents already open when the watcher starts are reported", () => {
  const opened = vi.spyOn(model, "handleDocumentOpened").mockReturnValue();
  editor.openDocument(path.join(workspace, "a.ts"), "one\n");
  editor.openDocument(path.join(workspace, "b.ts"), "two\n");

  // Activation happens after the window has restored its editors, so nothing else would tell the
  // model about them.
  watcher.activate();

  expect(opened).toHaveBeenCalledTimes(2);
});

test.each([
  { setting: "changelens.exclude", scoping: true },
  { setting: "changelens.respectGitignore", scoping: true },
  { setting: "changelens.maxFileSizeKb", scoping: true },
  { setting: "changelens.decorateEditor", scoping: false },
  { setting: "changelens.defaultViewMode", scoping: false },
])("changing $setting rescopes: $scoping", async ({ setting, scoping }) => {
  const rescope = vi.spyOn(model, "rescope").mockResolvedValue();
  const reload = vi.spyOn(model, "reloadConfig").mockResolvedValue();
  watcher.activate();

  editor.fireConfigurationChange(setting);
  await advance(0);

  // Only the settings that decide which files are tracked are worth a second walk of the workspace.
  expect(rescope).toHaveBeenCalledTimes(scoping ? 1 : 0);
  expect(reload).toHaveBeenCalledTimes(scoping ? 0 : 1);
});

test("a settings change outside ChangeLens is ignored entirely", async () => {
  const rescope = vi.spyOn(model, "rescope").mockResolvedValue();
  const reload = vi.spyOn(model, "reloadConfig").mockResolvedValue();
  watcher.activate();

  editor.fireConfigurationChange("editor.fontSize");
  await advance(0);

  expect(rescope).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

test("opening or closing a workspace folder rescopes and re-watches the repositories", async () => {
  const rescope = vi.spyOn(model, "rescope").mockResolvedValue();
  watcher.activate();
  await advance(0);
  const before = must(editor.watchersFor(".gitignore").at(-1), "the gitignore watcher");

  editor.state.events.foldersChanged.fire();
  await advance(0);

  expect(rescope).toHaveBeenCalledTimes(1);
  // The folder set decides what is watched, so the old watchers are replaced rather than added to.
  expect(before.disposed).toBe(true);
  expect(must(editor.watchersFor(".gitignore").at(-1), "the rebuilt watcher")).not.toBe(before);
});

test("a change to the governing HEAD reaches the branch-switch handler", async () => {
  watcher.activate();
  // The lookup that finds HEAD is asynchronous, so its watcher appears a turn after activation.
  await advance(0);

  must(editor.watchersFor("HEAD").at(-1), "the HEAD watcher").fire("change", uri(".git/HEAD"));
  await advance(600);

  expect(headChanges).toBe(1);
});

test("a HEAD lookup that lands after a re-watch registers nothing", async () => {
  const parked = deferred<string>();
  gitHead.resolve = () => parked.promise;
  watcher.activate();
  await advance(0);
  expect(editor.watchersFor("HEAD")).toEqual([]);

  // The folder set changed while the lookup was in the air, so its answer describes a workspace
  // arrangement that no longer exists.
  gitHead.resolve = (folder: string) => Promise.resolve(`${folder}/.git/HEAD`);
  editor.state.events.foldersChanged.fire();
  await advance(0);
  const current = editor.watchersFor("HEAD");
  expect(current).toHaveLength(1);

  parked.resolve(`${workspace}/.git/HEAD`);
  await advance(0);

  // Registering it now would leave a watcher nothing disposes, firing branch resets for a folder
  // that may already be closed.
  expect(editor.watchersFor("HEAD")).toEqual(current);
});

test("a HEAD lookup that lands after disposal registers nothing at all", async () => {
  const parked = deferred<string>();
  gitHead.resolve = () => parked.promise;
  watcher.activate();
  await advance(0);

  watcher.dispose();
  parked.resolve(`${workspace}/.git/HEAD`);
  await advance(0);

  // The window is closing; a watcher created now would outlive everything meant to dispose it.
  expect(editor.watchersFor("HEAD")).toEqual([]);
});

test("editing the gitignore rescopes, on the longer repository debounce", async () => {
  const rescope = vi.spyOn(model, "rescope").mockResolvedValue();
  watcher.activate();
  await advance(0);

  must(editor.watchersFor(".gitignore").at(-1), "the gitignore watcher").fire(
    "change",
    uri(".gitignore"),
  );

  await advance(200);
  expect(rescope).not.toHaveBeenCalled();

  await advance(400);
  expect(rescope).toHaveBeenCalledTimes(1);
});

test("editor file operations reach the handler that adopts them", () => {
  const created = vi.spyOn(model, "handleEditorCreate").mockResolvedValue();
  const deleted = vi.spyOn(model, "handleEditorDelete").mockResolvedValue();
  const renamed = vi.spyOn(model, "handleEditorRename").mockResolvedValue();
  watcher.activate();

  editor.state.events.filesCreated.fire({ files: [uri("mine.ts")] });
  editor.state.events.filesDeleted.fire({ files: [uri("gone.ts")] });
  editor.state.events.filesRenamed.fire({ files: [{ oldUri: uri("a.ts"), newUri: uri("b.ts") }] });

  // These are the user's own actions, so they are never debounced: each one is a single event.
  expect(created).toHaveBeenCalledTimes(1);
  expect(deleted).toHaveBeenCalledTimes(1);
  expect(renamed).toHaveBeenCalledTimes(1);
});

test("a handler that rejects is reported rather than left as an unhandled rejection", async () => {
  vi.spyOn(model, "handleDiskWrite").mockRejectedValue(new Error("disk full"));
  watcher.activate();

  // VS Code does not await event callbacks, so nothing downstream would ever see this.
  files().fire("change", uri("a.ts"));
  await advance(200);

  expect(errors).toEqual(["A file change could not be processed."]);
});

test("a handler that throws synchronously is reported the same way", () => {
  vi.spyOn(model, "handleDocumentOpened").mockImplementation(() => {
    throw new Error("bad document");
  });
  watcher.activate();

  editor.state.events.documentOpened.fire(
    editor.openDocument(path.join(workspace, "a.ts"), "one\n"),
  );

  expect(errors).toEqual(["A file open could not be processed."]);
});

test("disposing cancels work that was still waiting on its debounce", async () => {
  const write = vi.spyOn(model, "handleDiskWrite").mockResolvedValue();
  watcher.activate();

  files().fire("change", uri("a.ts"));
  watcher.dispose();
  await advance(500);

  // The window is closing; a pass that lands now would run against a model being torn down.
  expect(write).not.toHaveBeenCalled();
});

test("disposing releases every watcher it created", () => {
  watcher.activate();
  expect(editor.state.watchers.length).toBeGreaterThan(0);

  watcher.dispose();

  expect(editor.state.watchers.every((created) => created.disposed)).toBe(true);
});
