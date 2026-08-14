import * as path from "node:path";
import * as vscode from "vscode";
import { registerCommands } from "./commands";
import type { ViewMode } from "./config";
import { ChangeModel } from "./model";
import { BaselineStore } from "./storage";
import { handleGitHeadChanged } from "./tracking/branchChange";
import { WorkspaceWatcher } from "./tracking/watcher";
import { activeFileContext } from "./ui/activeFileContext";
import { ChangesTreeProvider } from "./ui/changesTree";
import { ChangeDecorationProvider } from "./ui/decorationProvider";
import { EditorHighlighter } from "./ui/editorDecorations";
import { HunkCodeLensProvider } from "./ui/hunkCodeLens";
import { ReviewContentProvider } from "./ui/reviewContentProvider";
import { BASE_SCHEME, CURRENT_SCHEME, fileKeyOf, REVIEW_SCHEME } from "./ui/schemes";
import { StatusBar } from "./ui/statusBar";

const ERROR_NOTICE_INTERVAL_MS = 60_000;

let activeStore: BaselineStore | undefined;
let activeModel: ChangeModel | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * What the window is doing, which the welcome view renders and the command palette gates on. Only
 * `ready` has a model behind it; the other three mean no command was registered or none can act.
 */
type Status = "noFolder" | "capturing" | "ready" | "failed";

function setStatus(status: Status): void {
  void vscode.commands.executeCommand("setContext", "changelens.status", status);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length || !context.storageUri) {
    // Nothing here will ever be captured, so the view has to say so instead of waiting forever.
    setStatus("noFolder");
    return;
  }

  setStatus("capturing");
  const output = vscode.window.createOutputChannel("ChangeLens");
  let lastNotice = 0;
  const report = (message: string, error?: unknown): void => {
    const detail = error === undefined ? "" : ` ${errorText(error)}`;
    output.appendLine(`${message}${detail}`);
    // A failed persist makes an Accept or a Reset look like it worked, so it has to reach the
    // user rather than sit in a log nobody opens. Throttled to survive a failing disk.
    if (Date.now() - lastNotice < ERROR_NOTICE_INTERVAL_MS) {
      return;
    }
    lastNotice = Date.now();
    void vscode.window.showWarningMessage(`ChangeLens: ${message}`, "Show Log").then((choice) => {
      if (choice === "Show Log") {
        output.show(true);
      }
      return undefined;
    });
  };
  const store = new BaselineStore(path.join(context.storageUri.fsPath, "baselines"), {
    onError: report,
  });
  activeStore = store;
  const model = new ChangeModel(store, context.workspaceState);
  activeModel = model;
  context.subscriptions.push(store, model, output);

  const tree = new ChangesTreeProvider(model);
  const contentProvider = new ReviewContentProvider(model);
  const decorations = new ChangeDecorationProvider(model);
  const codeLens = new HunkCodeLensProvider(model);
  const highlighter = new EditorHighlighter(model);
  const statusBar = new StatusBar(model);

  const updateActiveFileContext = () => {
    const { hasChanges, hasHunks } = activeFileContext(
      model,
      vscode.window.activeTextEditor?.document.uri,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "changelens.activeFileHasChanges",
      hasChanges,
    );
    void vscode.commands.executeCommand("setContext", "changelens.activeFileHasHunks", hasHunks);
  };

  const treeView = vscode.window.createTreeView("changelens.changes", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const revealActiveFile = () => {
    // `reveal` opens the view when it is hidden, which would pull the sidebar over whatever the
    // user is doing, so this only runs once the panel is already on screen.
    if (!treeView.visible || !model.config.autoReveal) {
      return;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const node = active ? tree.nodeForKey(fileKeyOf(active)) : undefined;
    if (node) {
      // Selection follows the editor; focus must not, or it would leave the file being typed in.
      void treeView.reveal(node, { select: true, focus: false });
    }
  };

  let publishedViewMode: ViewMode | undefined;
  const publishViewMode = () => {
    if (model.config.viewMode === publishedViewMode) {
      return;
    }
    const first = publishedViewMode === undefined;
    publishedViewMode = model.config.viewMode;
    void vscode.commands.executeCommand("setContext", "changelens.viewMode", publishedViewMode);
    // Regrouping replaces every row, which drops the selection. Content changes deliberately do
    // not reveal: the panel would keep reselecting while an agent writes.
    if (!first) {
      revealActiveFile();
    }
  };

  context.subscriptions.push(
    tree,
    contentProvider,
    decorations,
    codeLens,
    highlighter,
    statusBar,
    treeView,
    treeView.onDidChangeVisibility(() => revealActiveFile()),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, contentProvider),
    vscode.workspace.registerTextDocumentContentProvider(CURRENT_SCHEME, contentProvider),
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: CURRENT_SCHEME }, { scheme: REVIEW_SCHEME }, { scheme: "file" }],
      codeLens,
    ),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateActiveFileContext();
      revealActiveFile();
    }),
    model.onDidChange(() => {
      void vscode.commands.executeCommand("setContext", "changelens.hasChanges", model.hasChanges);
      updateActiveFileContext();
      publishViewMode();
    }),
  );

  registerCommands(context, model, store);
  publishViewMode();

  const watcher = new WorkspaceWatcher(model, () => handleGitHeadChanged(model), {
    onError: report,
  });
  context.subscriptions.push(watcher);

  try {
    await model.initialize();
  } catch (error) {
    // The capture already warned and offered the reload this window needs. Rethrowing would only
    // add VS Code's own activation failure on top of a message the user has already read.
    setStatus("failed");
    output.appendLine(`The baseline could not be captured. ${errorText(error)}`);
    return;
  }

  setStatus("ready");
  void vscode.commands.executeCommand("setContext", "changelens.hasChanges", model.hasChanges);
  watcher.activate();

  // Nothing was listening while the baseline was being built, so a write that landed after its
  // file was read raised no event anyone received. Stats recorded moments ago can still match such
  // a write, so this pass compares content and pays a second read of the workspace to do it.
  void model.reconcile(false).catch((error: unknown) => {
    report("The first scan for external changes did not finish.", error);
  });
}

/** Debounced index writes would otherwise be lost when a window closes right after an edit. */
export async function deactivate(): Promise<void> {
  const store = activeStore;
  const model = activeModel;
  activeStore = undefined;
  activeModel = undefined;
  // Handlers run detached from the event that started them, so a rebase or an accept can still
  // be in flight. Flushing before it reaches the store would write the state it was replacing.
  await model?.drain();
  await store?.flush();
}
