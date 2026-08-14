import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { normalizeKey } from "../src/core/paths";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import { ChangeDecorationProvider } from "../src/ui/decorationProvider";
import { REVIEW_SCHEME } from "../src/ui/schemes";
import { must } from "./helpers/assert";
import * as editor from "./helpers/vscode";

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;
let provider: ChangeDecorationProvider;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-decorations-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
  provider = new ChangeDecorationProvider(model);
});

afterEach(async () => {
  provider.dispose();
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

function decorationFor(name: string, scheme = "file") {
  return provider.provideFileDecoration(
    editor.asUri(editor.Uri.file(fsPath(name)).with({ scheme })),
  );
}

/** Every URI the provider has asked the editor to repaint, in order. */
function repaints(): string[][] {
  const seen: string[][] = [];
  provider.onDidChangeFileDecorations((uris) =>
    seen.push((uris ?? []).map((uri) => path.basename(uri.fsPath))),
  );
  return seen;
}

test.each([
  { how: "added", badge: "■" },
  { how: "modified", badge: "■" },
  { how: "deleted", badge: "■" },
])("a $how file carries the $badge badge and its own colour", async ({ how, badge }) => {
  await write("a.ts", "one\n");
  await model.initialize();

  if (how === "added") {
    await agentWrote("new.ts", "fresh\n");
  } else if (how === "modified") {
    await agentWrote("a.ts", "one\ntwo\n");
  } else {
    await fs.rm(fsPath("a.ts"));
    await model.handleDiskDelete(editor.asUri(editor.Uri.file(fsPath("a.ts"))));
  }

  const name = how === "added" ? "new.ts" : "a.ts";
  const decoration = must(decorationFor(name), `the ${how} file's decoration`);

  expect(decoration.badge).toBe(badge);
  expect(decoration.tooltip).toBe(`ChangeLens: ${how}`);
  expect(decoration.color).toEqual({ id: `changelens.${how}ResourceForeground` });
  // Folders show the badge of what is inside them, which is what makes a collapsed tree readable.
  expect(decoration.propagate).toBe(true);
});

test("a file nobody is reviewing is left undecorated", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  expect(decorationFor("b.ts")).toBeUndefined();
});

test("a review document is not decorated even though its file is", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  // The review carries the same path under its own scheme. Decorating it would badge the review
  // tab as if it were the working file.
  expect(decorationFor("a.ts")).toBeDefined();
  expect(decorationFor("a.ts", REVIEW_SCHEME)).toBeUndefined();
});

test("a file that leaves the review is repainted, not left wearing its badge", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const seen = repaints();
  await agentWrote("a.ts", "one\ntwo\n");
  expect(seen.at(-1)).toEqual(["a.ts"]);

  await model.acceptFile(key("a.ts"));

  // The file is no longer pending, so it appears in no new list. Naming only what is pending now
  // would leave the badge on screen until something else happened to repaint it.
  expect(model.files).toEqual([]);
  expect(seen.at(-1)).toEqual(["a.ts"]);
  expect(decorationFor("a.ts")).toBeUndefined();
});

test("a repaint names both the file that left and the one that arrived", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "two\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const seen = repaints();
  await model.acceptFile(key("a.ts"));
  await agentWrote("b.ts", "two\nthree\n");

  expect(seen.at(-1)).toEqual(["b.ts"]);
  expect(seen.at(-2)).toEqual(["a.ts"]);
});

test("a disposed provider stops following the model", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const seen = repaints();
  provider.dispose();
  await agentWrote("a.ts", "one\ntwo\n");

  expect(seen).toEqual([]);
});
