import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { normalizeKey } from "../src/core/paths";
import { ChangeModel } from "../src/model/changeModel";
import { BaselineStore } from "../src/storage/baselineStore";
import {
  BRANCH_CHANGED_PROMPT,
  handleGitHeadChanged,
  KEEP_PENDING,
  RESET_BASELINE,
} from "../src/tracking/branchChange";
import * as editor from "./helpers/vscode";

let root: string;
let workspace: string;
let store: BaselineStore;
let model: ChangeModel;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "changelens-branch-"));
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

function key(name: string): string {
  return normalizeKey(fsPath(name));
}

async function write(name: string, text: string): Promise<void> {
  await fs.writeFile(fsPath(name), text, "utf8");
}

/** Rewrites a tracked file the way a checkout does, without the watcher having reported it yet. */
async function branchRewrote(name: string, text: string): Promise<void> {
  await write(name, text);
  await model.handleDiskWrite(editor.asUri(editor.Uri.file(fsPath(name))));
}

/** Answers the branch dialog with the given button, or dismisses it when omitted. */
function userClicks(label?: string): void {
  editor.state.answer = (_message, items) =>
    label !== undefined && items.includes(label) ? label : undefined;
}

test("a branch change before the baseline exists is ignored", async () => {
  await write("a.ts", "on main\n");
  const capture = vi.spyOn(model, "captureBaseline");

  // Activation failed or has not finished, so there is no baseline to reset and no review to keep.
  expect(model.ready).toBe(false);
  await handleGitHeadChanged(model);

  expect(capture).not.toHaveBeenCalled();
  expect(editor.state.shown).toEqual([]);
});

test("a branch change with nothing pending resets the baseline without asking", async () => {
  await write("a.ts", "on main\n");
  await model.initialize();

  await write("a.ts", "on the feature branch\n");
  await handleGitHeadChanged(model);

  // Nothing was under review, so every rewritten file belongs to the checkout, not to an agent.
  expect(editor.state.shown).toEqual([]);
  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "on the feature branch\n",
    hadBom: false,
  });
});

test("a branch change with pending work asks before discarding the review", async () => {
  await write("a.ts", "on main\n");
  await model.initialize();
  await branchRewrote("a.ts", "written by an agent\n");

  userClicks(RESET_BASELINE);
  await handleGitHeadChanged(model);

  expect(editor.state.shown.at(-1)?.message).toBe(BRANCH_CHANGED_PROMPT);
  expect(editor.state.shown.at(-1)?.items).toEqual([RESET_BASELINE, KEEP_PENDING]);
  expect(model.files).toEqual([]);
  expect(await store.readBaseline(key("a.ts"))).toEqual({
    kind: "text",
    text: "written by an agent\n",
    hadBom: false,
  });
});

test("keeping the pending changes leaves the baseline where it was", async () => {
  await write("a.ts", "on main\n");
  await model.initialize();
  await branchRewrote("a.ts", "written by an agent\n");

  userClicks(KEEP_PENDING);
  await handleGitHeadChanged(model);

  expect(model.get(key("a.ts"))?.status).toBe("modified");
  expect(model.get(key("a.ts"))?.baselineText).toBe("on main\n");
});

test("dismissing the branch dialog keeps the review rather than resetting it", async () => {
  await write("a.ts", "on main\n");
  await model.initialize();
  await branchRewrote("a.ts", "written by an agent\n");

  // Escape answers nothing, which must not be read as consent to discard the review.
  userClicks();
  await handleGitHeadChanged(model);

  expect(model.get(key("a.ts"))?.baselineText).toBe("on main\n");
});
