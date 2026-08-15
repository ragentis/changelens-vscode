import * as vscode from "vscode";
import type { ChangeModel, FileStatus } from "../model";
import { fileKeyOf, isReviewUri, toTreeUri, TREE_SCHEME } from "./schemes";

/**
 * A square in the status colour, rather than a letter that would read as one of Git's own A/M/D
 * marks. Only glyphs the UI font itself carries work here: the badge is drawn at 90% size inside
 * the label's line box.
 */
const BADGES: Record<FileStatus, string> = {
  added: "■",
  modified: "■",
  deleted: "■",
};

const COLORS: Record<FileStatus, string> = {
  added: "changelens.addedResourceForeground",
  modified: "changelens.modifiedResourceForeground",
  deleted: "changelens.deletedResourceForeground",
};

export class ChangeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  private readonly subscription: vscode.Disposable;
  private decorated: vscode.Uri[] = [];

  constructor(private readonly model: ChangeModel) {
    this.subscription = model.onDidChange(() => {
      const next = model.files.map((file) => file.uri);
      const changed = [...this.decorated, ...next];
      // Reviews are taken from what is open rather than from what is pending, so the tab of a file
      // that just left the review is repainted instead of keeping its badge.
      const reviews = vscode.workspace.textDocuments
        .filter((doc) => isReviewUri(doc.uri))
        .map((doc) => doc.uri);
      // Tree rows use another scheme, so repaint them explicitly instead of leaving a cached colour
      // behind when a path moves between added, deleted, and absent states.
      this._onDidChangeFileDecorations.fire([
        ...changed,
        ...changed.map((uri) => toTreeUri(uri)),
        ...reviews,
      ]);
      this.decorated = next;
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const onDisk = uri.scheme === "file";
    const inTree = uri.scheme === TREE_SCHEME;
    if (!onDisk && !inTree && !isReviewUri(uri)) {
      return undefined;
    }
    const file = this.model.get(fileKeyOf(uri));
    if (!file) {
      return undefined;
    }
    if (inTree && file.status === "modified") {
      return undefined;
    }
    // The tree uses its own URI scheme so Git cannot merge a badge into these rows. ChangeLens
    // colours only added and deleted rows there, and leaves badges to real files and review tabs.
    const decoration: vscode.FileDecoration = {
      color: new vscode.ThemeColor(COLORS[file.status]),
      tooltip: `ChangeLens: ${file.status}`,
      // Only Explorer folders summarize descendant changes; tree folders stay undecorated.
      propagate: onDisk,
    };
    if (!inTree) {
      decoration.badge = BADGES[file.status];
    }
    return decoration;
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
