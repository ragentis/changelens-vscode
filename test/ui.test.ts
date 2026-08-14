import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerCommands } from "../src/commands";
import { normalizeKey } from "../src/core/paths";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import { activeFileContext } from "../src/ui/activeFileContext";
import { ChangesTreeProvider } from "../src/ui/changesTree";
import { HunkCodeLensProvider } from "../src/ui/hunkCodeLens";
import { ReviewFileSystemProvider } from "../src/ui/reviewFileSystemProvider";
import { BASE_SCHEME, CURRENT_SCHEME, REVIEW_SCHEME } from "../src/ui/schemes";
import { must } from "./helpers/assert";
import * as editor from "./helpers/vscode";

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-ui-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
  registerCommands(editor.createExtensionContext(), model, store);
});

afterEach(async () => {
  vi.restoreAllMocks();
  model.dispose();
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

function fsPath(...segments: string[]): string {
  return path.join(workspace, ...segments);
}

function key(...segments: string[]): string {
  return normalizeKey(fsPath(...segments));
}

async function write(name: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(fsPath(name)), { recursive: true });
  await fs.writeFile(fsPath(name), text, "utf8");
}

/** Reports the file as changed on disk, the way the watcher would. */
async function agentWrote(name: string, text: string): Promise<void> {
  await write(name, text);
  await model.handleDiskWrite(editor.asUri(editor.Uri.file(fsPath(name))));
}

async function agentDeleted(name: string): Promise<void> {
  await fs.rm(fsPath(name));
  await model.handleDiskDelete(editor.asUri(editor.Uri.file(fsPath(name))));
}

function lastMessage(): string {
  return editor.state.shown.at(-1)?.message ?? "";
}

/** Mounts the review file system on the given schemes, the way activation does. */
function serveReviews(...schemes: string[]): ReviewFileSystemProvider {
  const provider = new ReviewFileSystemProvider(model);
  for (const scheme of schemes) {
    editor.workspace.registerFileSystemProvider(scheme, provider, { isReadonly: true });
  }
  return provider;
}

function reviewUri(scheme: string, name: string): editor.Uri {
  return editor.Uri.file(fsPath(name)).with({ scheme });
}

async function served(
  provider: ReviewFileSystemProvider,
  scheme: string,
  name: string,
): Promise<string> {
  return Buffer.from(await provider.readFile(editor.asUri(reviewUri(scheme, name)))).toString(
    "utf8",
  );
}

// #region the changes tree

type TreeNode = ReturnType<ChangesTreeProvider["getChildren"]>[number];

function tree(): ChangesTreeProvider {
  return new ChangesTreeProvider(model);
}

function labelOf(provider: ChangesTreeProvider, node: TreeNode): string {
  const { label } = provider.getTreeItem(node);
  return typeof label === "string" ? label : (label?.label ?? "");
}

/** The tree flattened to its labels, parents before their children. */
function rows(provider: ChangesTreeProvider, parent?: TreeNode): string[] {
  const collected: string[] = [];
  for (const node of provider.getChildren(parent)) {
    collected.push(labelOf(provider, node));
    collected.push(...rows(provider, node));
  }
  return collected;
}

test("a single-root tree groups by folder without a redundant root above it", async () => {
  await write("src/ui/a.ts", "one\n");
  await model.initialize();
  await agentWrote("src/ui/a.ts", "one\ntwo\n");

  const provider = tree();
  expect(rows(provider)).toEqual(["src/ui", "a.ts"]);
  provider.dispose();
});

test("a folder row carries the real directory, so decorations can reach it", async () => {
  await write("src/ui/a.ts", "one\n");
  await write("src/model/b.ts", "one\n");
  await model.initialize();
  await agentWrote("src/ui/a.ts", "one\ntwo\n");
  await agentWrote("src/model/b.ts", "one\ntwo\n");

  const provider = tree();
  const src = must(provider.getChildren()[0], "the src folder row");
  expect(provider.getTreeItem(src).resourceUri?.fsPath).toBe(fsPath("src"));

  const folders = provider
    .getChildren(src)
    .map((node) => provider.getTreeItem(node).resourceUri?.fsPath);
  expect(folders).toEqual([fsPath("src", "model"), fsPath("src", "ui")]);
  provider.dispose();
});

test("list mode labels each file with its folder and follows the setting", async () => {
  await write("src/ui/a.ts", "one\n");
  await model.initialize();
  await agentWrote("src/ui/a.ts", "one\ntwo\n");

  editor.state.configuration.set("changelens.defaultViewMode", "list");
  await model.reloadConfig();

  const provider = tree();
  const only = must(provider.getChildren()[0], "the single file row");
  expect(provider.getTreeItem(only).description).toBe("src/ui · +1 −0");
  provider.dispose();
});

test("a file row reports its folder chain upwards, which is what reveal walks", async () => {
  await write("src/ui/a.ts", "one\n");
  await write("src/model/b.ts", "one\n");
  await model.initialize();
  await agentWrote("src/ui/a.ts", "one\ntwo\n");
  await agentWrote("src/model/b.ts", "one\ntwo\n");

  const provider = tree();
  const node = must(provider.nodeForKey(key("src", "ui", "a.ts")), "the file row");

  const chain: string[] = [];
  for (let step = provider.getParent(node); step; step = provider.getParent(step)) {
    chain.push(labelOf(provider, step));
  }

  expect(chain).toEqual(["ui", "src"]);
  expect(provider.getParent(must(provider.getChildren()[0], "the root row"))).toBeUndefined();
  provider.dispose();
});

test("a compressed folder shortens the chain instead of inventing a row", async () => {
  await write("src/ui/a.ts", "one\n");
  await model.initialize();
  await agentWrote("src/ui/a.ts", "one\ntwo\n");

  const provider = tree();
  const node = must(provider.nodeForKey(key("src", "ui", "a.ts")), "the file row");
  const parent = must(provider.getParent(node), "its only ancestor");

  // `src` and `ui` render as one row, so the walk up ends there rather than passing through both.
  expect(labelOf(provider, parent)).toBe("src/ui");
  expect(provider.getParent(parent)).toBeUndefined();
  provider.dispose();
});

test("list mode has rows to reveal but no chain above them", async () => {
  await write("src/ui/a.ts", "one\n");
  await model.initialize();
  await agentWrote("src/ui/a.ts", "one\ntwo\n");

  editor.state.configuration.set("changelens.defaultViewMode", "list");
  await model.reloadConfig();

  const provider = tree();
  const node = must(provider.nodeForKey(key("src", "ui", "a.ts")), "the file row");
  expect(provider.getParent(node)).toBeUndefined();
  provider.dispose();
});

test("every refresh replaces the row, so reveal has to look it up again", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const provider = tree();
  const before = must(provider.nodeForKey(key("a.ts")), "the file row");

  await agentWrote("a.ts", "one\ntwo\nthree\n");
  const after = must(provider.nodeForKey(key("a.ts")), "the rebuilt file row");

  expect(after).not.toBe(before);
  expect(provider.getChildren()).toContain(after);

  await model.acceptFile(key("a.ts"));
  expect(provider.nodeForKey(key("a.ts"))).toBeUndefined();
  provider.dispose();
});

// #endregion

// #region deletions

test("accepting a block of a deleted file is refused instead of emptying its baseline", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentDeleted("a.ts");

  const pending = must(model.get(key("a.ts")), "the pending deletion");
  expect(pending.status).toBe("deleted");
  const signature = must(pending.signatures[0], "the deletion's block signature");

  expect(await model.acceptHunk(key("a.ts"), signature)).toBe(false);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "one\ntwo\n",
    hadBom: false,
  });
});

test("reverting a block of a deleted file is refused, since the file is the unit", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentDeleted("a.ts");

  const pending = must(model.get(key("a.ts")), "the pending deletion");
  const signature = must(pending.signatures[0], "the deletion's block signature");

  // There is no document to apply an edit to. Reverting the file recreates it; reverting a block
  // of it has no meaning, so it must refuse rather than half-restore.
  expect(await model.revertHunk(key("a.ts"), signature)).toBe(false);
  await expect(fs.access(fsPath("a.ts"))).rejects.toThrow(/ENOENT/);
});

test("a deleted file still reverts to its original content after a refused block accept", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentDeleted("a.ts");

  const pending = must(model.get(key("a.ts")), "the pending deletion");
  await model.acceptHunk(key("a.ts"), must(pending.signatures[0], "its block signature"));
  expect(await model.revertFile(key("a.ts"))).toBe(true);

  expect(await fs.readFile(fsPath("a.ts"), "utf8")).toBe("one\ntwo\n");
});

test("opening a deleted file shows its baseline rather than failing on the missing path", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  const provider = serveReviews(BASE_SCHEME);
  await agentDeleted("a.ts");

  await editor.run("changelens.openFile", key("a.ts"));

  const shown = editor.state.shownDocuments.at(-1);
  expect(shown?.scheme).toBe(BASE_SCHEME);
  expect(editor.state.activeTextEditor?.document.getText()).toBe("one\ntwo\n");
  provider.dispose();
});

test("a contentless deletion says its previous version cannot be shown", async () => {
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x01]));
  await model.initialize();
  await agentDeleted("logo.png");

  expect(must(model.get(key("logo.png")), "the pending deletion").opaqueReason).toBe("binary");

  await editor.run("changelens.openFile", key("logo.png"));

  expect(lastMessage()).toContain("tracked without content");
  expect(editor.state.shownDocuments).toEqual([]);
});

// #endregion

// #region the block at the cursor

async function openReview(name: string): Promise<editor.TextDocument> {
  serveReviews(REVIEW_SCHEME);
  return await editor.workspace.openTextDocument(reviewUri(REVIEW_SCHEME, name));
}

test("a cursor outside every block accepts nothing and says so", async () => {
  await write("a.ts", "one\ntwo\nthree\nfour\nfive\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\nthree\nfour\nCHANGED\n");

  const doc = await openReview("a.ts");
  editor.setActiveEditor(doc, 0);
  await editor.run("changelens.acceptHunkAtCursor");

  expect(lastMessage()).toContain("put the cursor inside a changed block");
  expect(model.files).toHaveLength(1);
});

test("a cursor inside a block accepts that block", async () => {
  await write("a.ts", "one\ntwo\nthree\nfour\nfive\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\nthree\nfour\nCHANGED\n");

  const doc = await openReview("a.ts");
  const unified = must(model.get(key("a.ts"))?.unified, "the unified view");
  const block = must(unified.hunks[0], "its first block");

  editor.setActiveEditor(doc, block.start);
  await editor.run("changelens.acceptHunkAtCursor");

  expect(model.files).toEqual([]);
});

test("the baseline side of a diff resolves blocks by baseline lines, not current ones", async () => {
  await write("a.ts", "a\nb\nc\nd\ne\n");
  await model.initialize();
  await agentWrote("a.ts", "a\nN1\nN2\nb\nc\nD\ne\n");

  const file = must(model.get(key("a.ts")), "the pending file");
  const second = must(file.hunks[1], "the second block");
  // The insertion above shifts the current side, so the two coordinates disagree here.
  expect([second.baseStart, second.currStart]).toEqual([3, 5]);

  const provider = serveReviews(BASE_SCHEME);
  const base = await editor.workspace.openTextDocument(reviewUri(BASE_SCHEME, "a.ts"));
  editor.setActiveEditor(base, second.baseStart);
  await editor.run("changelens.acceptHunkAtCursor");

  // Reading the cursor as a current-side line would have matched nothing and refused.
  expect(must(model.get(key("a.ts")), "the still-pending file").hunks).toHaveLength(1);
  provider.dispose();
});

// #endregion

// #region hunk code lenses

function lensesFor(doc: editor.TextDocument): { title: string; line: number; args: unknown[] }[] {
  const provider = new HunkCodeLensProvider(model);
  const lenses = provider.provideCodeLenses(editor.asDocument(doc));
  provider.dispose();
  return lenses.map((lens) => ({
    title: String(lens.command?.title),
    line: lens.range.start.line,
    args: lens.command?.arguments ?? [],
  }));
}

test("a lens pair per block anchors to the unified layout, not the working line", async () => {
  await write("a.ts", "a\nb\nc\nd\ne\n");
  await model.initialize();
  await agentWrote("a.ts", "a\nB\nc\nD\ne\n");

  const file = must(model.get(key("a.ts")), "the pending file");
  const lenses = lensesFor(await openReview("a.ts"));

  expect(lenses.map((lens) => lens.title)).toEqual([
    "$(check) Accept change",
    "$(discard) Revert",
    "$(check) Accept change",
    "$(discard) Revert",
  ]);
  // Removed lines are interleaved above their replacements, so every block after the first sits
  // lower in the unified document than its `currStart` in the working file.
  expect(must(file.hunks[1], "the second block").currStart).toBe(3);
  expect(lenses.map((lens) => lens.line)).toEqual([1, 1, 4, 4]);
  expect(lenses[2]?.args).toEqual([file.key, file.signatures[1]]);
});

test("on the baseline side a lens anchors by baseline lines", async () => {
  await write("a.ts", "a\nb\nc\nd\ne\n");
  await model.initialize();
  await agentWrote("a.ts", "a\nX\nY\nb\nc\nD\ne\n");

  const file = must(model.get(key("a.ts")), "the pending file");
  const first = must(file.hunks[0], "the first block");
  const second = must(file.hunks[1], "the second block");
  // The insertion above it pushes the second block down in the working file but not in the
  // baseline, so the two sides disagree about which line the block is on. Anchoring by `currStart`
  // would put this lens two lines below the code it acts on.
  expect(second.currStart).toBeGreaterThan(second.baseStart);

  const baseline = editor.openDocument(fsPath("a.ts"), "a\nb\nc\nd\ne\n", false, BASE_SCHEME);

  // The same placement the cursor commands read, which the block-at-the-cursor region proves they
  // agree on; here it only has to be where the lens is drawn.
  expect(lensesFor(baseline).map((lens) => lens.line)).toEqual([
    first.baseStart,
    first.baseStart,
    second.baseStart,
    second.baseStart,
  ]);
});

test("a deletion and a contentless file offer no block lenses", async () => {
  await write("a.ts", "one\n");
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x01]));
  await model.initialize();
  await agentDeleted("a.ts");
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x02, 0x03]));
  await model.handleDiskWrite(editor.asUri(editor.Uri.file(fsPath("logo.png"))));

  expect(lensesFor(editor.openDocument(fsPath("a.ts"), ""))).toEqual([]);
  expect(lensesFor(editor.openDocument(fsPath("logo.png"), ""))).toEqual([]);
});

test("the editor setting hides lenses in the file but never in the review", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentWrote("a.ts", "one\nCHANGED\n");

  editor.state.configuration.set("changelens.showCodeLensInEditor", false);
  await model.reloadConfig();

  expect(lensesFor(editor.openDocument(fsPath("a.ts"), "one\nCHANGED\n"))).toEqual([]);
  expect(lensesFor(await openReview("a.ts"))).toHaveLength(2);
});

// #endregion

// #region virtual review documents

test("the review provider serves a side per scheme", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const provider = serveReviews(BASE_SCHEME, CURRENT_SCHEME, REVIEW_SCHEME);

  // Both sides of the built-in diff come from here, so serving the same text to both would render
  // an empty diff for a file that really did change.
  expect(await served(provider, BASE_SCHEME, "a.ts")).toBe("one\n");
  expect(await served(provider, CURRENT_SCHEME, "a.ts")).toBe("one\ntwo\n");
  expect(await served(provider, REVIEW_SCHEME, "a.ts")).toContain("two");
  provider.dispose();
});

test("the review file system refuses every way of writing to it", () => {
  const provider = serveReviews(REVIEW_SCHEME);

  // Read-only is declared at registration, but a caller reaching the provider directly must still
  // be turned away rather than silently doing nothing.
  expect(() => provider.writeFile()).toThrow("NoPermissions");
  expect(() => provider.delete()).toThrow("NoPermissions");
  expect(() => provider.rename()).toThrow("NoPermissions");
  expect(() => provider.createDirectory()).toThrow("NoPermissions");
  provider.dispose();
});

test("listing a review as a directory is refused as a wrong shape, not as a permission", () => {
  const provider = serveReviews(REVIEW_SCHEME);

  // Every review URI names a file. Reporting this as `NoPermissions` would suggest a read-only
  // directory that a caller could usefully retry against.
  expect(() => provider.readDirectory(editor.asUri(reviewUri(REVIEW_SCHEME, "a.ts")))).toThrow(
    "FileNotADirectory",
  );
  provider.dispose();
});

test("a review that cannot be resolved opens empty instead of failing the editor", async () => {
  const provider = serveReviews(REVIEW_SCHEME);

  // `stat` runs before every open, so throwing here would surface as an error notification for a
  // file the model has never heard of.
  const uri = editor.asUri(reviewUri(REVIEW_SCHEME, "gone.ts"));
  expect((await provider.stat(uri)).size).toBe(0);
  expect(await served(provider, REVIEW_SCHEME, "gone.ts")).toBe("");
  provider.dispose();
});

test("each refresh moves the stat, so no reload is skipped for landing in the same millisecond", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const provider = serveReviews(REVIEW_SCHEME);
  const uri = editor.asUri(reviewUri(REVIEW_SCHEME, "a.ts"));
  await editor.workspace.openTextDocument(reviewUri(REVIEW_SCHEME, "a.ts"));

  // Frozen, so only the provider's own guard can move the stat. The editor reloads on a moved stat
  // alone, and a plain clock reading repeats for two changes inside one millisecond.
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

  const first = (await provider.stat(uri)).mtime;
  await agentWrote("a.ts", "one\ntwo\nthree\n");
  const second = (await provider.stat(uri)).mtime;
  await agentWrote("a.ts", "one\ntwo\nthree\nfour\n");
  const third = (await provider.stat(uri)).mtime;

  expect(second).toBeGreaterThan(first);
  expect(third).toBeGreaterThan(second);
  provider.dispose();
});

test("an open review refreshes after its file leaves the pending list", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const provider = serveReviews(REVIEW_SCHEME);
  const uri = reviewUri(REVIEW_SCHEME, "a.ts");
  await editor.workspace.openTextDocument(uri);

  const refreshed: string[] = [];
  provider.onDidChangeFile((events) =>
    refreshed.push(...events.map((event) => event.uri.toString())),
  );

  await model.acceptFile(key("a.ts"));

  expect(model.files).toEqual([]);
  expect(refreshed).toContain(uri.toString());
  expect(await served(provider, REVIEW_SCHEME, "a.ts")).toBe("one\ntwo\n");
  provider.dispose();
});

test("a review of an unopened file is not announced on every change", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "one\n");
  await model.initialize();

  const provider = serveReviews(REVIEW_SCHEME);
  const refreshed: string[] = [];
  provider.onDidChangeFile((events) =>
    refreshed.push(...events.map((event) => event.uri.toString())),
  );

  await agentWrote("a.ts", "one\ntwo\n");
  await agentWrote("b.ts", "one\ntwo\n");

  expect(model.files).toHaveLength(2);
  expect(refreshed).toEqual([]);
  provider.dispose();
});

test("a review reverted through an unsaved buffer shows the buffer, not the stale disk", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  const provider = serveReviews(REVIEW_SCHEME);
  await editor.workspace.openTextDocument(reviewUri(REVIEW_SCHEME, "a.ts"));
  const buffer = editor.openDocument(fsPath("a.ts"), "one\ntwo\n");

  expect(await model.revertFile(key("a.ts"))).toBe(true);

  // A workspace edit leaves the revert unsaved, so disk still holds what the agent wrote.
  expect(buffer.getText()).toBe("one\n");
  expect(await fs.readFile(fsPath("a.ts"), "utf8")).toBe("one\ntwo\n");
  expect(model.files).toEqual([]);
  expect(await served(provider, REVIEW_SCHEME, "a.ts")).toBe("one\n");
  provider.dispose();
});

// #endregion

// #region editor-title context keys

/**
 * The two keys the `editor/title` menus gate on. `hasChanges` shows the Open Change entry over a
 * working file; `hasHunks` shows Accept/Revert Block, which needs a block to act on.
 */
function contextFor(uri: editor.Uri | undefined) {
  return activeFileContext(model, uri ? editor.asUri(uri) : undefined);
}

function underScheme(name: string, scheme: string): editor.Uri {
  return editor.Uri.file(fsPath(name)).with({ scheme });
}

test("an editor showing nothing under review offers neither entry", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  expect(contextFor(undefined)).toEqual({ hasChanges: false, hasHunks: false });
  expect(contextFor(editor.Uri.file(fsPath("a.ts")))).toEqual({
    hasChanges: false,
    hasHunks: false,
  });
});

test("a pending file offers both entries in the working file", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  expect(contextFor(editor.Uri.file(fsPath("a.ts")))).toEqual({
    hasChanges: true,
    hasHunks: true,
  });
});

test.each([REVIEW_SCHEME, BASE_SCHEME, CURRENT_SCHEME])(
  "a %s document offers the block entries but not Open Change",
  async (scheme) => {
    await write("a.ts", "one\n");
    await model.initialize();
    await agentWrote("a.ts", "one\ntwo\n");

    // Open Change is menued on `resourceScheme == file`, so a review document must not claim it,
    // or the review would offer to open a review of itself.
    expect(contextFor(underScheme("a.ts", scheme))).toEqual({ hasChanges: false, hasHunks: true });
  },
);

test("a deletion is pending but has no block to accept or revert", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentDeleted("a.ts");

  expect(contextFor(editor.Uri.file(fsPath("a.ts")))).toEqual({
    hasChanges: true,
    hasHunks: false,
  });
});

test("a file tracked without content is pending but has no block either", async () => {
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x01]));
  await model.initialize();
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x02, 0x03]));
  await model.handleDiskWrite(editor.asUri(editor.Uri.file(fsPath("logo.png"))));

  expect(must(model.get(key("logo.png")), "the pending file").opaqueReason).toBe("binary");
  expect(contextFor(editor.Uri.file(fsPath("logo.png")))).toEqual({
    hasChanges: true,
    hasHunks: false,
  });
});

test("another extension's document over a tracked path claims neither entry", async () => {
  await write("a.ts", "one\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  // Git's own diff views carry the same path under their own scheme, and ChangeLens has nothing
  // to offer inside them.
  expect(contextFor(underScheme("a.ts", "git"))).toEqual({ hasChanges: false, hasHunks: false });
});

// #endregion
