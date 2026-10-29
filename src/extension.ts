import * as path from "node:path";
import * as vscode from "vscode";
import { registerCommands } from "./commands";
import type { ViewMode } from "./config";
import { ChangeModel, countFiles } from "./model";
import { BaselineStore } from "./storage";
import { GitSync } from "./tracking/gitSync";
import { WorkspaceWatcher } from "./tracking/watcher";
import { activeFileContext } from "./ui/activeFileContext";
import { ChangesTreeProvider } from "./ui/changesTree";
import { ChangeDecorationProvider } from "./ui/decorationProvider";
import { EditorHighlighter } from "./ui/editorDecorations";
import { HunkCodeLensProvider } from "./ui/hunkCodeLens";
import { ReviewFileSystemProvider } from "./ui/reviewFileSystemProvider";
import { mirrorReviewLanguages } from "./ui/reviewLanguage";
import { CURRENT_SCHEME, fileKeyOf, REVIEW_SCHEME, REVIEW_SCHEMES } from "./ui/schemes";
import { StatusBar } from "./ui/statusBar";

const ERROR_NOTICE_INTERVAL_MS = 60_000;
/** How long VS Code has to stop asking for rows before a show or a refresh is treated as settled. */
const FETCH_QUIET_MS = 300;
/** A tree that keeps fetching this long is handled anyway, or a reveal would never follow. */
const SETTLE_LIMIT_MS = 3_000;
/** How many times a refresh VS Code drew with rows missing is sent again before it is left. */
const REBUILD_LIMIT = 3;

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
  const output = vscode.window.createOutputChannel("ChangeLens", { log: true });
  let lastNotice = 0;
  const report = (message: string, error?: unknown): void => {
    const detail = error === undefined ? "" : ` ${errorText(error)}`;
    output.error(`${message}${detail}`);
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
  const model = new ChangeModel(store, context.workspaceState, output);
  activeModel = model;
  context.subscriptions.push(store, model, output);

  const tree = new ChangesTreeProvider(model);
  const reviewFiles = new ReviewFileSystemProvider(model);
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
  tree.setVisible(treeView.visible);

  const pendingCount = () => countFiles(model.files.length);

  let settleTimer: NodeJS.Timeout | undefined;
  let showPending = false;
  let revealPending = false;
  let reselect: string | undefined;
  let rebuilds = 0;

  /** Replaces every row VS Code holds, remembering the selection for once the rows are drawn. */
  const repair = () => {
    reselect ??= tree.selectionKey(treeView.selection[0]);
    tree.rebuild();
  };

  const revealActiveFile = (): boolean => {
    // `reveal` opens the view when it is hidden, which would pull the sidebar over whatever the
    // user is doing, so this only runs once the panel is already on screen.
    if (!treeView.visible || !model.config.autoReveal) {
      return false;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const node = active ? tree.nodeForKey(fileKeyOf(active)) : undefined;
    if (!active || !node) {
      return false;
    }
    // Selection follows the editor; focus must not, or it would leave the file being typed in.
    void treeView.reveal(node, { select: true, focus: false }).then(undefined, (error: unknown) => {
      // The node came from the model, so a row VS Code cannot find means the panel it drew is
      // behind the model.
      const detail = error instanceof Error ? error.message : String(error);
      output.warn(
        `The changes panel had no row for ${vscode.workspace.asRelativePath(active)}, so it was rebuilt from the model. ${detail}`,
      );
      repair();
    });
    return true;
  };

  const restoreSelection = () => {
    const node = reselect === undefined ? undefined : tree.nodeForSelection(reselect);
    reselect = undefined;
    if (node) {
      void treeView.reveal(node, { select: true, focus: false }).then(undefined, () => undefined);
    }
  };

  /**
   * Checks what VS Code drew once it has settled. A refresh or a reveal sent while VS Code is
   * still fetching rows cancels the fetches in flight, and the folders they were for are drawn
   * empty, so nothing touches the panel until the fetching has stopped or the deadline passes.
   * `afterMs` is how long to wait before the first look: a refresh needs VS Code to have started
   * fetching, while a show finds VS Code's own fetches already recorded.
   */
  const settleLater = (afterMs: number) => {
    clearTimeout(settleTimer);
    const deadline = Date.now() + SETTLE_LIMIT_MS;
    const wait = () => {
      settleTimer = undefined;
      const remaining = FETCH_QUIET_MS - tree.sinceLastFetch();
      if (remaining > 0 && Date.now() < deadline) {
        settleTimer = setTimeout(wait, remaining);
        return;
      }
      settled();
    };
    if (afterMs > 0) {
      settleTimer = setTimeout(wait, afterMs);
    } else {
      wait();
    }
  };

  const settled = () => {
    const missing = tree.undrawn();
    if (showPending) {
      showPending = false;
      revealPending = true;
      if (missing.length === 0) {
        output.info(`The changes panel was shown with ${pendingCount()} already drawn.`);
      } else {
        // A hidden panel is sent no refreshes, so a show usually finds the rows VS Code drew
        // before the panel was hidden.
        repair();
        output.info(`The changes panel was shown and rebuilt with ${pendingCount()}.`);
        return;
      }
    }
    if (missing.length === 0) {
      rebuilds = 0;
      output.debug(`The changes panel drew ${pendingCount()}.`);
      if (revealPending) {
        revealPending = false;
        if (revealActiveFile()) {
          reselect = undefined;
        }
      }
      restoreSelection();
      return;
    }
    // VS Code has fetched the rows it was going to, and some folders got none: those are drawn
    // empty. A fresh refresh is the only repair available from this side.
    const rows = missing.join(", ");
    if (rebuilds >= REBUILD_LIMIT) {
      rebuilds = 0;
      revealPending = false;
      reselect = undefined;
      output.warn(
        `The changes panel still has no rows for ${rows} after ${REBUILD_LIMIT} rebuilds, so it is left as drawn until the next refresh.`,
      );
      return;
    }
    rebuilds += 1;
    output.warn(
      `The changes panel drew ${pendingCount()} without the rows of ${rows}, so it was rebuilt from the model (${rebuilds} of ${REBUILD_LIMIT}).`,
    );
    repair();
  };

  let publishedViewMode: ViewMode | undefined;
  const publishViewMode = () => {
    if (model.config.viewMode === publishedViewMode) {
      return;
    }
    const first = publishedViewMode === undefined;
    publishedViewMode = model.config.viewMode;
    void vscode.commands.executeCommand("setContext", "changelens.viewMode", publishedViewMode);
    // Regrouping replaces every row, which drops the selection, so the reveal follows once the
    // new rows are drawn. Content changes deliberately do not reveal: the panel would keep
    // reselecting while an agent writes.
    if (!first) {
      revealPending = true;
    }
  };

  context.subscriptions.push(
    tree,
    reviewFiles,
    decorations,
    codeLens,
    highlighter,
    statusBar,
    treeView,
    { dispose: () => clearTimeout(settleTimer) },
    treeView.onDidChangeVisibility(({ visible }) => {
      tree.setVisible(visible);
      if (visible) {
        showPending = true;
        settleLater(0);
      } else {
        clearTimeout(settleTimer);
        settleTimer = undefined;
        showPending = false;
        revealPending = false;
        reselect = undefined;
      }
    }),
    // Every refresh the panel sends is checked against what VS Code then fetched.
    tree.onDidChangeTreeData(() => settleLater(FETCH_QUIET_MS)),
    treeView.onDidCollapseElement(({ element }) => tree.setCollapsed(element, true)),
    treeView.onDidExpandElement(({ element }) => tree.setCollapsed(element, false)),
    vscode.window.onDidChangeWindowState(({ focused }) => {
      // A refresh can also be lost while the window sits idle with the panel on screen, where no
      // show follows to rebuild it.
      if (focused && treeView.visible) {
        repair();
        output.info(
          `The window regained focus and the changes panel was rebuilt with ${pendingCount()}.`,
        );
      }
    }),
    // Case sensitivity follows `normalizeKey`, so the editor and the model agree on which paths
    // name the same review. Read-only is what keeps the document from being typed into.
    ...REVIEW_SCHEMES.map((scheme) =>
      vscode.workspace.registerFileSystemProvider(scheme, reviewFiles, {
        isReadonly: true,
        isCaseSensitive: process.platform !== "win32",
      }),
    ),
    mirrorReviewLanguages(),
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

  const gitSync = new GitSync(model, context.workspaceState);
  const watcher = new WorkspaceWatcher(model, (folder) => gitSync.sync(folder), {
    onError: report,
  });
  context.subscriptions.push(watcher);

  try {
    await model.initialize();
  } catch (error) {
    // The capture already warned and offered the reload this window needs. Rethrowing would only
    // add VS Code's own activation failure on top of a message the user has already read.
    setStatus("failed");
    output.error(`The baseline could not be captured. ${errorText(error)}`);
    return;
  }

  setStatus("ready");
  void vscode.commands.executeCommand("setContext", "changelens.hasChanges", model.hasChanges);
  watcher.activate();

  // A pull that landed while this window was closed is Git's work, not an agent's. This asks Git
  // before it can join the model's chain, so the reconcile below reaches it first and briefly
  // reports those files; the adoption that follows takes them back out.
  void gitSync.syncAll().catch((error: unknown) => {
    report("The check for Git changes made outside this window did not finish.", error);
  });

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
