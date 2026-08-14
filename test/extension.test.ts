import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activate, deactivate } from "../src/extension";
import { must } from "./helpers/assert";
import { deferred } from "./helpers/async";
import * as editor from "./helpers/vscode";

/**
 * The composition root. These tests cover the decisions it makes — what status the window reports,
 * when the panel follows the active editor, and how a failing disk is announced — rather than the
 * wiring, which is only `subscriptions.push`.
 */

// Real Git would spawn a child in the temp workspace, which then cannot be removed on Windows.
vi.mock("../src/tracking/gitHead", () => ({
  resolveGitHead: (folder: string) => Promise.resolve(`${folder}/.git/HEAD`),
}));

let root: string;
let workspace: string;
let storage: string;
let context: ReturnType<typeof editor.createExtensionContext>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-extension-"));
  workspace = path.join(root, "workspace");
  storage = path.join(root, "storage");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  context = editor.createExtensionContext(storage);
});

afterEach(async () => {
  // `deactivate` drains the handlers still in flight; removing the workspace under them would make
  // every later test fail for the wrong reason.
  await deactivate();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
  await fs.rm(root, { recursive: true, force: true });
});

function fsPath(name: string): string {
  return path.join(workspace, name);
}

async function write(name: string, text: string): Promise<void> {
  await fs.writeFile(fsPath(name), text, "utf8");
}

/**
 * Rewrites a file and has the extension notice it through Refresh rather than the watcher, whose
 * debounce would make every assertion a race. The watcher's own wiring is covered separately.
 */
async function agentWrote(name: string, text: string): Promise<void> {
  await write(name, text);
  await editor.run("changelens.refresh");
}

async function accept(name: string, text: string): Promise<void> {
  await agentWrote(name, text);
  await editor.run("changelens.acceptFile", editor.Uri.file(fsPath(name)));
}

/** The last value pushed for a context key, which is what the `when` clauses read. */
function contextKey(name: string): unknown {
  const set = editor.state.executed.filter(
    (call) => call.command === "setContext" && call.args[0] === name,
  );
  return set.at(-1)?.args[1];
}

const treeView = () => must(editor.state.treeViews.at(-1), "the changes view");
const output = () => must(editor.state.outputChannels.at(-1), "the output channel");
const warnings = () => editor.state.shown.filter((shown) => shown.kind === "warning");

test("a window with no folder open says so and registers nothing", async () => {
  editor.setWorkspaceFolders([]);

  await activate(context);

  // Nothing here will ever be captured, so the welcome view has to explain itself rather than sit
  // on a spinner forever.
  expect(contextKey("changelens.status")).toBe("noFolder");
  expect(editor.state.commands.size).toBe(0);
});

test("a window with nowhere to persist is treated the same way", async () => {
  await activate(editor.createExtensionContext(undefined));

  expect(contextKey("changelens.status")).toBe("noFolder");
  expect(editor.state.commands.size).toBe(0);
});

test("a successful activation ends ready, with the commands in place", async () => {
  await write("a.ts", "one\n");

  await activate(context);

  expect(contextKey("changelens.status")).toBe("ready");
  expect(contextKey("changelens.hasChanges")).toBe(false);
  expect(editor.state.commands.has("changelens.acceptFile")).toBe(true);
});

test("an activation that cannot capture reports failed instead of throwing", async () => {
  await write("a.ts", "one\n");
  // A file where the blob directory has to go, so no baseline content can be stored at all.
  await fs.mkdir(path.join(storage, "baselines"), { recursive: true });
  await fs.writeFile(path.join(storage, "baselines", "blobs"), "x");

  // Rethrowing would stack VS Code's own activation failure on top of the message the capture has
  // already put in front of the user.
  await expect(activate(context)).resolves.toBeUndefined();

  expect(contextKey("changelens.status")).toBe("failed");
  expect(output().lines.join("\n")).toContain("The baseline could not be captured.");
});

test("a pending change is published to the welcome view", async () => {
  await write("a.ts", "one\n");
  await activate(context);
  expect(contextKey("changelens.hasChanges")).toBe(false);

  await write("a.ts", "one\ntwo\n");
  editor
    .watchersFor("**/*")
    .at(-1)
    ?.fire("change", editor.Uri.file(fsPath("a.ts")));
  await vi.waitUntil(() => contextKey("changelens.hasChanges") === true);

  expect(contextKey("changelens.hasChanges")).toBe(true);
});

test("the panel follows the active editor once the file is under review", async () => {
  await write("a.ts", "one\n");
  await activate(context);
  await agentWrote("a.ts", "one\ntwo\n");

  editor.setActiveEditor(editor.openDocument(fsPath("a.ts"), "one\ntwo\n"));

  const [reveal] = treeView().revealed.slice(-1);
  // Selection follows the editor; focus must not, or it would leave the file being typed in.
  expect(reveal?.options).toEqual({ select: true, focus: false });
});

test("a hidden panel is never pulled open by the editor moving", async () => {
  await write("a.ts", "one\n");
  await activate(context);
  await agentWrote("a.ts", "one\ntwo\n");

  treeView().setVisible(false);
  const before = treeView().revealed.length;
  editor.setActiveEditor(editor.openDocument(fsPath("a.ts"), "one\ntwo\n"));

  // `reveal` opens the view when it is hidden, which would drag the sidebar over whatever the user
  // is doing.
  expect(treeView().revealed).toHaveLength(before);
});

test("autoReveal off keeps the panel where the user left it", async () => {
  editor.state.configuration.set("changelens.autoReveal", false);
  await write("a.ts", "one\n");
  await activate(context);
  await agentWrote("a.ts", "one\ntwo\n");

  editor.setActiveEditor(editor.openDocument(fsPath("a.ts"), "one\ntwo\n"));

  expect(treeView().revealed).toEqual([]);
});

test("the view mode is published once at startup and again only when it changes", async () => {
  await write("a.ts", "one\n");
  await activate(context);
  expect(contextKey("changelens.viewMode")).toBe("tree");
  const published = editor.state.executed.filter(
    (call) => call.command === "setContext" && call.args[0] === "changelens.viewMode",
  ).length;

  await editor.run("changelens.viewAsList");

  expect(contextKey("changelens.viewMode")).toBe("list");
  expect(
    editor.state.executed.filter(
      (call) => call.command === "setContext" && call.args[0] === "changelens.viewMode",
    ),
  ).toHaveLength(published + 1);
});

test("a failing disk is announced once a minute, but logged every time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  // A directory where the index has to be written fails the rename on every platform.
  await fs.mkdir(path.join(storage, "baselines", "index.json"), { recursive: true });
  await fs.writeFile(path.join(storage, "baselines", "index.json", "blocker"), "x");

  await activate(context);
  const logged = output().lines.length;
  expect(warnings()).toHaveLength(1);

  // Accepting persists, so a dying disk keeps producing failures the user has to know about — but
  // it must not turn into a dialog per file.
  await accept("a.ts", "one\nchanged\n");
  expect(warnings()).toHaveLength(1);
  expect(output().lines.length).toBeGreaterThan(logged);

  vi.setSystemTime(Date.now() + 61_000);
  await accept("b.ts", "two\nchanged\n");

  expect(warnings().length).toBeGreaterThan(1);
});

test("taking the warning's offer opens the log it was written to", async () => {
  await write("a.ts", "one\n");
  await fs.mkdir(path.join(storage, "baselines", "index.json"), { recursive: true });
  await fs.writeFile(path.join(storage, "baselines", "index.json", "blocker"), "x");
  editor.state.answer = (_message, items) => items.find((item) => item === "Show Log");

  await activate(context);
  // The dialog is answered outside the activation chain, so its follow-up lands a turn later.
  await vi.waitUntil(() => output().shown > 0);

  expect(must(editor.state.shown.at(-1), "the warning").items).toEqual(["Show Log"]);
  expect(output().shown).toBe(1);
});

test("a first scan that fails is logged without taking activation down", async () => {
  await write("a.ts", "one\n");
  const findFiles = editor.workspace.findFiles.bind(editor.workspace);
  let scans = 0;
  vi.spyOn(editor.workspace, "findFiles").mockImplementation(async (include, exclude) => {
    scans += 1;
    // The capture goes first and has to succeed; the detached pass behind it is the one under test.
    if (scans > 1) {
      throw new Error("the workspace went away");
    }
    return findFiles(include, exclude);
  });

  await activate(context);

  // Nobody awaits that pass, so a failure in it would otherwise be silent.
  expect(contextKey("changelens.status")).toBe("ready");
  await vi.waitUntil(() =>
    output().lines.some((line) => line.includes("The first scan for external changes")),
  );
});

test("deactivating waits for the work still in flight before it flushes", async () => {
  await write("a.ts", "one\n");
  await activate(context);
  await write("a.ts", "one\ntwo\n");

  // Park the pass inside its read of the workspace, where it has changed nothing yet.
  const held = deferred();
  const readFile = editor.workspace.fs.readFile.bind(editor.workspace.fs);
  vi.spyOn(editor.workspace.fs, "readFile").mockImplementation(async (target) => {
    await held.promise;
    return readFile(target);
  });

  // Detached, the way the watcher dispatches it: nobody but `deactivate` is waiting on this.
  const inFlight = editor.run("changelens.refresh");
  let closed = false;
  const closing = deactivate().then(() => void (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Flushing here would persist the state the parked pass is about to replace.
  expect(closed).toBe(false);

  held.resolve();
  await closing;
  await inFlight;

  expect(closed).toBe(true);
  const index = await fs.readFile(path.join(storage, "baselines", "index.json"), "utf8");
  expect(index).toContain("a.ts");
});

test("deactivating twice is harmless, since the second call has nothing left to close", async () => {
  await write("a.ts", "one\n");
  await activate(context);

  await deactivate();
  await expect(deactivate()).resolves.toBeUndefined();
});
