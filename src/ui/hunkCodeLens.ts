import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { fileKeyOf, REVIEW_SCHEME } from "./schemes";

export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: ChangeModel) {
    this.subscription = model.onDidChange(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme === "file" && !this.model.config.showCodeLensInEditor) {
      return [];
    }
    const file = this.model.get(fileKeyOf(document.uri));
    if (!file || file.opaqueReason || file.status === "deleted") {
      return [];
    }

    const unified = document.uri.scheme === REVIEW_SCHEME ? file.unified : undefined;
    const lastLine = Math.max(document.lineCount - 1, 0);
    const lenses: vscode.CodeLens[] = [];

    file.hunks.forEach((hunk, index) => {
      const signature = file.signatures[index];
      if (signature === undefined) {
        return;
      }
      const anchor = unified ? (unified.hunks[index]?.start ?? hunk.currStart) : hunk.currStart;
      const line = Math.min(Math.max(anchor, 0), lastLine);
      const range = new vscode.Range(line, 0, line, 0);
      const args = [file.key, signature];
      lenses.push(
        new vscode.CodeLens(range, {
          command: "changelens.acceptHunk",
          title: `$(check) Accept ${label(hunk.kind)}`,
          arguments: args,
        }),
        new vscode.CodeLens(range, {
          command: "changelens.revertHunk",
          title: "$(discard) Revert",
          arguments: args,
        }),
      );
    });
    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeCodeLenses.dispose();
  }
}

function label(kind: string): string {
  switch (kind) {
    case "add":
      return "addition";
    case "delete":
      return "deletion";
    default:
      return "change";
  }
}
