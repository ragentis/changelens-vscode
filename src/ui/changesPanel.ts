import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { countFiles } from "../model";
import { type ChangesNode, ChangesTreeProvider } from "./changesTree";
import { fileKeyOf } from "./schemes";

/** How long VS Code has to stop asking for rows before a show or a refresh is treated as settled. */
const FETCH_QUIET_MS = 300;
/** A tree that keeps fetching this long is handled anyway, or a reveal would never follow. */
const SETTLE_LIMIT_MS = 3_000;
/** How many times a refresh VS Code drew with rows missing is sent again before it is left. */
const REBUILD_LIMIT = 3;

/**
 * The changes view, and what keeps what VS Code draws in step with the model. VS Code fetches and
 * draws the rows itself, and can end up with fewer than it was given: a refresh or a reveal sent
 * while it is still fetching cancels those fetches, and a folder it gave up on stays collapsed
 * and empty through every later refresh of the same rows. So nothing touches the panel until VS
 * Code has gone quiet, every refresh is then checked against what VS Code fetched, and a panel
 * drawn wrong is rebuilt with rows VS Code cannot match to the ones it holds.
 */
export class ChangesPanel implements vscode.Disposable {
  private readonly tree: ChangesTreeProvider;
  private readonly view: vscode.TreeView<ChangesNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private settleTimer: NodeJS.Timeout | undefined;
  private showPending = false;
  private revealPending = false;
  /** The selected row's key, kept across a rebuild because the rebuild replaces the row. */
  private reselect: string | undefined;
  private rebuilds = 0;

  constructor(
    private readonly model: ChangeModel,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.tree = new ChangesTreeProvider(model);
    this.view = vscode.window.createTreeView("changelens.changes", {
      treeDataProvider: this.tree,
      showCollapseAll: true,
    });
    this.tree.setVisible(this.view.visible);
    this.disposables.push(
      this.tree,
      this.view,
      this.view.onDidChangeVisibility(({ visible }) => this.onDidChangeVisibility(visible)),
      // Every refresh the panel sends is checked against what VS Code then fetched.
      this.tree.onDidChangeTreeData(() => this.settleLater()),
      this.view.onDidCollapseElement(({ element }) => this.tree.setCollapsed(element, true)),
      this.view.onDidExpandElement(({ element }) => this.tree.setCollapsed(element, false)),
      vscode.window.onDidChangeWindowState(({ focused }) => {
        // A panel left on screen while the window sat idle gets no show to repair it, and what
        // VS Code lost on its own side cannot be seen from here.
        if (focused && this.view.visible) {
          this.repair();
          this.log.debug(
            `The window regained focus and the changes panel was rebuilt with ${this.pendingCount()}.`,
          );
        }
      }),
    );
  }

  /**
   * Selects the active editor's row when the file is under review, without taking focus from the
   * editor. Returns whether there was such a row.
   */
  revealActiveFile(): boolean {
    // `reveal` opens the view when it is hidden, which would pull the sidebar over whatever the
    // user is doing, so this only runs once the panel is already on screen.
    if (!this.view.visible || !this.model.config.autoReveal) {
      return false;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const node = active ? this.tree.nodeForKey(fileKeyOf(active)) : undefined;
    if (!active || !node) {
      return false;
    }
    void this.view
      .reveal(node, { select: true, focus: false })
      .then(undefined, (error: unknown) => {
        // The node came from the model, so a row VS Code cannot find means the panel it drew is
        // behind the model.
        const detail = error instanceof Error ? error.message : String(error);
        this.log.warn(
          `The changes panel had no row for ${vscode.workspace.asRelativePath(active)}, so it was rebuilt from the model. ${detail}`,
        );
        this.repair();
      });
    return true;
  }

  /** Reveals the active file once the rows now being drawn are in place. */
  revealWhenDrawn(): void {
    this.revealPending = true;
  }

  dispose(): void {
    clearTimeout(this.settleTimer);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private pendingCount(): string {
    return countFiles(this.model.files.length);
  }

  /** Replaces every row VS Code holds, remembering the selection for once the rows are drawn. */
  private repair(): void {
    this.reselect ??= this.tree.selectionKey(this.view.selection[0]);
    this.tree.rebuild();
  }

  private restoreSelection(): void {
    const node =
      this.reselect === undefined ? undefined : this.tree.nodeForSelection(this.reselect);
    this.reselect = undefined;
    if (node) {
      void this.view.reveal(node, { select: true, focus: false }).then(undefined, () => undefined);
    }
  }

  private onDidChangeVisibility(visible: boolean): void {
    this.tree.setVisible(visible);
    if (visible) {
      this.showPending = true;
      // On the first show VS Code builds the tree itself, and those fetches start after it has
      // reported the view visible. A rebuild sent before they are done cancels them, and the
      // folders they were for are drawn empty, so the check waits for them to come and go.
      this.settleLater(!this.tree.everFetched());
      return;
    }
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.showPending = false;
    this.revealPending = false;
    this.reselect = undefined;
  }

  /**
   * Runs {@link settled} once VS Code has stopped asking for rows, or at the deadline. The first
   * look comes after a quiet period, which gives VS Code time to start fetching. With `awaitFetch`
   * it also waits for VS Code to have asked for rows at all since now.
   */
  private settleLater(awaitFetch = false): void {
    clearTimeout(this.settleTimer);
    const since = Date.now();
    const deadline = since + SETTLE_LIMIT_MS;
    const wait = () => {
      this.settleTimer = undefined;
      const sinceLastFetch = this.tree.sinceLastFetch();
      const fetched = !awaitFetch || Date.now() - sinceLastFetch >= since;
      const remaining = FETCH_QUIET_MS - sinceLastFetch;
      if ((remaining > 0 || !fetched) && Date.now() < deadline) {
        this.settleTimer = setTimeout(wait, remaining > 0 ? remaining : FETCH_QUIET_MS);
        return;
      }
      this.settled();
    };
    this.settleTimer = setTimeout(wait, FETCH_QUIET_MS);
  }

  private settled(): void {
    const missing = this.tree.undrawn();
    if (this.showPending) {
      this.showPending = false;
      this.revealPending = true;
      if (missing.length === 0) {
        this.log.info(`The changes panel was shown with ${this.pendingCount()} already drawn.`);
      } else {
        // A hidden panel is sent no refreshes, so a show usually finds the rows VS Code drew
        // before the panel was hidden.
        this.repair();
        this.log.info(
          `The changes panel was shown and rebuilt with ${this.pendingCount()}, as VS Code had no rows for ${missing.join(", ")}.`,
        );
        return;
      }
    }
    if (missing.length === 0) {
      this.rebuilds = 0;
      this.log.debug(`The changes panel drew ${this.pendingCount()}.`);
      if (this.revealPending) {
        this.revealPending = false;
        if (this.revealActiveFile()) {
          this.reselect = undefined;
        }
      }
      this.restoreSelection();
      return;
    }
    const rows = missing.join(", ");
    if (this.rebuilds >= REBUILD_LIMIT) {
      this.rebuilds = 0;
      this.revealPending = false;
      this.reselect = undefined;
      this.log.warn(
        `The changes panel still has no rows for ${rows} after ${REBUILD_LIMIT} rebuilds, so it is left as drawn until the next refresh.`,
      );
      return;
    }
    this.rebuilds += 1;
    this.log.warn(
      `The changes panel drew ${this.pendingCount()} without the rows of ${rows}, so it was rebuilt from the model (${this.rebuilds} of ${REBUILD_LIMIT}).`,
    );
    this.repair();
  }
}
