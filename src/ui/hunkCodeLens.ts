import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { clampSpan, placeHunks } from "./hunkGeometry";
import { fileKeyOf } from "./schemes";

/**
 * VS Code restarts its wait before reading lenses on every change event, and until it reads them
 * it shows remembered lenses that have no command. Events spaced at least this far apart leave it
 * room to finish.
 */
export const LENS_REFRESH_INTERVAL_MS = 1000;

export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly subscription: vscode.Disposable;
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private queuedRefresh: NodeJS.Timeout | undefined;

  constructor(private readonly model: ChangeModel) {
    this.subscription = model.onDidChange(() => this.refresh());
  }

  /** The first change is announced at once; later ones within the interval share one trailing event. */
  private refresh(): void {
    if (this.queuedRefresh) {
      return;
    }
    const wait = this.lastRefresh + LENS_REFRESH_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.announce();
      return;
    }
    this.queuedRefresh = setTimeout(() => {
      this.queuedRefresh = undefined;
      this.announce();
    }, wait);
  }

  private announce(): void {
    this.lastRefresh = Date.now();
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme === "file" && !this.model.config.showCodeLensInEditor) {
      return [];
    }
    const file = this.model.get(fileKeyOf(document.uri));
    if (!file) {
      return [];
    }

    const lastLine = Math.max(document.lineCount - 1, 0);
    const lenses: vscode.CodeLens[] = [];

    placeHunks(file, document.uri.scheme).forEach((placement, index) => {
      const hunk = file.hunks[index];
      const signature = file.signatures[index];
      if (!hunk || signature === undefined) {
        return;
      }
      const { first } = clampSpan(placement.block, lastLine);
      const range = new vscode.Range(first, 0, first, 0);
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
    clearTimeout(this.queuedRefresh);
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
