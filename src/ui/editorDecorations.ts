import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import type { LineSpan } from "./hunkGeometry";
import { clampSpan, placeHunks } from "./hunkGeometry";
import { fileKeyOf, isReviewUri, REVIEW_SCHEME } from "./schemes";

export class EditorHighlighter implements vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  private readonly deleted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  private readonly deletionMarker = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    borderWidth: "2px 0 0 0",
    borderStyle: "solid",
    overviewRulerColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly model: ChangeModel) {
    this.disposables.push(
      model.onDidChange(() => this.renderAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      // A review document reloads after the model change that invalidated it, and the editor
      // shifts the decorations already on screen by the lines that reload removed. Repainting
      // against the arrived content puts them back where the model placed them.
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isReviewUri(event.document.uri)) {
          this.renderDocument(event.document);
        }
      }),
    );
    this.renderAll();
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor);
    }
  }

  private renderDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === document.uri.toString()) {
        this.render(editor);
      }
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.deleted, []);
    editor.setDecorations(this.deletionMarker, []);
  }

  private render(editor: vscode.TextEditor): void {
    const scheme = editor.document.uri.scheme;
    if (scheme !== REVIEW_SCHEME && (scheme !== "file" || !this.model.config.decorateEditor)) {
      this.clear(editor);
      return;
    }
    const placements = placeHunks(this.model.get(fileKeyOf(editor.document.uri)), scheme);
    const lastLine = Math.max(editor.document.lineCount - 1, 0);
    const addedRanges: vscode.Range[] = [];
    const deletedRanges: vscode.Range[] = [];
    const markers: vscode.Range[] = [];

    for (const { removed, added, block } of placements) {
      if (removed.count > 0) {
        deletedRanges.push(toRange(removed, lastLine));
      }
      if (added.count > 0) {
        addedRanges.push(toRange(added, lastLine));
      }
      // A block the working file shows as neither: the lines it removed live only in the baseline.
      if (removed.count === 0 && added.count === 0) {
        markers.push(toRange(block, lastLine));
      }
    }

    editor.setDecorations(this.added, addedRanges);
    editor.setDecorations(this.deleted, deletedRanges);
    editor.setDecorations(this.deletionMarker, markers);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.added.dispose();
    this.deleted.dispose();
    this.deletionMarker.dispose();
  }
}

function toRange(span: LineSpan, lastLine: number): vscode.Range {
  const { first, last } = clampSpan(span, lastLine);
  return new vscode.Range(first, 0, last, 0);
}
