import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import { EditorHighlighter } from "../src/ui/editorDecorations";
import { REVIEW_SCHEME } from "../src/ui/schemes";
import { must } from "./helpers/assert";
import * as editor from "./helpers/vscode";

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;
let highlighter: EditorHighlighter | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-highlight-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  editor.reset();
  editor.setWorkspaceFolders([workspace]);
  store = new BaselineStore(path.join(root, "state"));
  model = new ChangeModel(store);
});

afterEach(async () => {
  highlighter?.dispose();
  highlighter = undefined;
  model.dispose();
  await store.flush();
  await fs.rm(root, { recursive: true, force: true });
});

function fsPath(name: string): string {
  return path.join(workspace, name);
}

async function write(name: string, text: string): Promise<void> {
  await fs.writeFile(fsPath(name), text, "utf8");
}

/** Reports the file as changed on disk, the way the watcher would. */
async function agentWrote(name: string, text: string): Promise<void> {
  await write(name, text);
  await model.handleDiskWrite(editor.asUri(editor.Uri.file(fsPath(name))));
}

/**
 * The three decoration types in the order the highlighter creates them. They are opaque handles,
 * so the only way to tell them apart is the order of construction.
 */
const ADDED = 0;
const DELETED = 1;
const MARKER = 2;

/** Renders `doc` on screen and returns the lines each decoration type ended up covering. */
function render(doc: editor.TextDocument): number[][] {
  const [shown] = editor.setVisibleEditors(doc);
  const surface = must(shown, "the visible editor");
  highlighter ??= new EditorHighlighter(model);
  // The constructor renders once; a later call needs the event the editor would have raised.
  editor.state.visibleEditorsChanged.fire([surface]);

  const types = [...surface.decorations.keys()];
  return [ADDED, DELETED, MARKER].map((index) => {
    const type = types[index];
    const ranges = type ? (surface.decorations.get(type) ?? []) : [];
    return ranges.flatMap((range) =>
      Array.from({ length: range.end.line - range.start.line + 1 }, (_, i) => range.start.line + i),
    );
  });
}

test("added lines are highlighted in the working file", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentWrote("a.ts", "one\nTWO\nthree\n");

  const [added, deleted, markers] = render(
    editor.openDocument(fsPath("a.ts"), "one\nTWO\nthree\n"),
  );

  // The working file shows only what is there now; the replaced line lives in the baseline.
  expect(added).toEqual([1, 2]);
  expect(deleted).toEqual([]);
  expect(markers).toEqual([]);
});

test("a block that only removed lines is marked, since it has nothing to highlight", async () => {
  await write("a.ts", "one\ntwo\nthree\n");
  await model.initialize();
  await agentWrote("a.ts", "one\nthree\n");

  const [added, deleted, markers] = render(editor.openDocument(fsPath("a.ts"), "one\nthree\n"));

  // Nothing was added and the removed line is not in this document at all, so without the marker
  // the deletion would be invisible in the editor.
  expect(added).toEqual([]);
  expect(deleted).toEqual([]);
  expect(markers).toEqual([1]);
});

test("the review document shows both sides, unlike the working file", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentWrote("a.ts", "one\nTWO\n");

  const [added, deleted] = render(
    editor.openDocument(fsPath("a.ts"), "one\ntwo\nTWO\n", false, REVIEW_SCHEME),
  );

  // The unified view interleaves the removed line above its replacement, so both get a colour.
  expect(deleted).toEqual([1]);
  expect(added).toEqual([2]);
});

test("the decorateEditor setting hides highlights in the file but never in the review", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentWrote("a.ts", "one\nTWO\n");

  editor.state.configuration.set("changelens.decorateEditor", false);
  await model.reloadConfig();

  expect(render(editor.openDocument(fsPath("a.ts"), "one\nTWO\n"))).toEqual([[], [], []]);
  expect(
    render(editor.openDocument(fsPath("a.ts"), "one\ntwo\nTWO\n", false, REVIEW_SCHEME)).flat(),
  ).not.toEqual([]);
});

test("an editor showing a file nobody is reviewing is cleared", async () => {
  await write("a.ts", "one\n");
  await write("b.ts", "quiet\n");
  await model.initialize();
  await agentWrote("a.ts", "one\ntwo\n");

  // Clearing rather than skipping: the editor may still be holding decorations from before the
  // file was accepted.
  expect(render(editor.openDocument(fsPath("b.ts"), "quiet\n"))).toEqual([[], [], []]);
});

test("a deletion and a contentless file draw nothing at all", async () => {
  await write("a.ts", "one\n");
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x01]));
  await model.initialize();

  await fs.rm(fsPath("a.ts"));
  await model.handleDiskDelete(editor.asUri(editor.Uri.file(fsPath("a.ts"))));
  await fs.writeFile(fsPath("logo.png"), Buffer.from([0x89, 0x00, 0x02, 0x03]));
  await model.handleDiskWrite(editor.asUri(editor.Uri.file(fsPath("logo.png"))));

  expect(render(editor.openDocument(fsPath("a.ts"), ""))).toEqual([[], [], []]);
  expect(render(editor.openDocument(fsPath("logo.png"), ""))).toEqual([[], [], []]);
});

test("accepting a file repaints the editor that was showing it", async () => {
  await write("a.ts", "one\ntwo\n");
  await model.initialize();
  await agentWrote("a.ts", "one\nTWO\n");

  const doc = editor.openDocument(fsPath("a.ts"), "one\nTWO\n");
  const [shown] = editor.setVisibleEditors(doc);
  const surface = must(shown, "the visible editor");
  highlighter = new EditorHighlighter(model);
  expect([...surface.decorations.values()].flat()).not.toEqual([]);

  await model.acceptFile(model.files[0]?.key ?? "");

  // The model's own change event is the only signal here; nothing re-opened the editor.
  expect([...surface.decorations.values()].flat()).toEqual([]);
});

test("a disposed highlighter releases its decoration types", async () => {
  await write("a.ts", "one\n");
  await model.initialize();

  const created: editor.TextEditorDecorationType[] = [];
  const make = editor.window.createTextEditorDecorationType.bind(editor.window);
  editor.window.createTextEditorDecorationType = (options) => {
    const type = make(options);
    created.push(type);
    return type;
  };
  highlighter = new EditorHighlighter(model);
  editor.window.createTextEditorDecorationType = make;

  highlighter.dispose();
  highlighter = undefined;

  expect(created).toHaveLength(3);
  expect(created.every((type) => type.disposed)).toBe(true);
});
