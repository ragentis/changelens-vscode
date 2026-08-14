import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { normalizeKey } from "../src/core/paths";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import { StatusBar } from "../src/ui/statusBar";
import { must } from "./helpers/assert";
import * as editor from "./helpers/vscode";

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;
let statusBar: StatusBar;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-statusbar-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
  statusBar = new StatusBar(model);
});

afterEach(async () => {
  statusBar.dispose();
  model.dispose();
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

function fsPath(name: string): string {
  return path.join(workspace, name);
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
  await model.handleDiskWrite(editor.asUri(editor.Uri.file(fsPath(name))));
}

const item = () => must(editor.state.statusBarItems[0], "the status bar item");

test("with nothing pending the item stays off the bar", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  // A permanent zero would be noise in a bar the user shares with everything else.
  expect(item().visible).toBe(false);
});

test("one pending file reads in the singular and clicking it opens the view", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  expect(item().visible).toBe(true);
  expect(item().text).toBe("$(git-compare) 1");
  expect(item().tooltip).toBe("ChangeLens: 1 file awaiting review");
  expect(item().command).toBe("changelens.changes.focus");
});

test("more than one pending file reads in the plural", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");
  await agentWrote("b.ts", "two\nthree\n");

  expect(item().text).toBe("$(git-compare) 2");
  expect(item().tooltip).toBe("ChangeLens: 2 files awaiting review");
});

test("the item leaves the bar again once the review is empty", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");
  expect(item().visible).toBe(true);

  await model.acceptFile(key("a.ts"));

  expect(item().visible).toBe(false);
});

test("a disposed status bar takes its item with it and stops counting", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  statusBar.dispose();
  await agentWrote("a.ts", "one\ntwo\n");

  expect(item().disposed).toBe(true);
  expect(item().visible).toBe(false);
});
