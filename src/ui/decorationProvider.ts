import * as vscode from "vscode";
import type { ChangeModel, FileStatus } from "../model";

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
      this._onDidChangeFileDecorations.fire([...this.decorated, ...next]);
      this.decorated = next;
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const file = this.model.getByUri(uri);
    if (!file) {
      return undefined;
    }
    return {
      badge: BADGES[file.status],
      color: new vscode.ThemeColor(COLORS[file.status]),
      tooltip: `ChangeLens: ${file.status}`,
      propagate: true,
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
