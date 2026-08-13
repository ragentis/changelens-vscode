import * as vscode from "vscode";
import type { ChangeModel, PendingFile } from "../model";
import { fileKeyOf, REVIEW_SCHEME } from "./schemes";

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
    );
    this.renderAll();
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor);
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.deleted, []);
    editor.setDecorations(this.deletionMarker, []);
  }

  private render(editor: vscode.TextEditor): void {
    const scheme = editor.document.uri.scheme;
    const isReview = scheme === REVIEW_SCHEME;
    if (!isReview && (scheme !== "file" || !this.model.config.decorateEditor)) {
      this.clear(editor);
      return;
    }
    const file = this.model.get(fileKeyOf(editor.document.uri));
    if (!file || file.opaqueReason || file.status === "deleted") {
      this.clear(editor);
      return;
    }
    if (isReview) {
      this.renderUnified(editor, file);
    } else {
      this.renderWorkingFile(editor, file);
    }
  }

  private renderUnified(editor: vscode.TextEditor, file: PendingFile): void {
    if (!file.unified) {
      this.clear(editor);
      return;
    }
    const lastLine = Math.max(editor.document.lineCount - 1, 0);
    const addedRanges: vscode.Range[] = [];
    const deletedRanges: vscode.Range[] = [];
    for (const hunk of file.unified.hunks) {
      if (hunk.removedCount > 0) {
        deletedRanges.push(lineSpan(hunk.removedStart, hunk.removedCount, lastLine));
      }
      if (hunk.addedCount > 0) {
        addedRanges.push(lineSpan(hunk.addedStart, hunk.addedCount, lastLine));
      }
    }
    editor.setDecorations(this.added, addedRanges);
    editor.setDecorations(this.deleted, deletedRanges);
    editor.setDecorations(this.deletionMarker, []);
  }

  private renderWorkingFile(editor: vscode.TextEditor, file: PendingFile): void {
    const lastLine = Math.max(editor.document.lineCount - 1, 0);
    const addedRanges: vscode.Range[] = [];
    const markers: vscode.Range[] = [];
    for (const hunk of file.hunks) {
      if (hunk.currLines.length > 0) {
        addedRanges.push(lineSpan(hunk.currStart, hunk.currLines.length, lastLine));
      } else {
        const line = Math.min(hunk.currStart, lastLine);
        markers.push(new vscode.Range(line, 0, line, 0));
      }
    }
    editor.setDecorations(this.added, addedRanges);
    editor.setDecorations(this.deleted, []);
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

function lineSpan(start: number, count: number, lastLine: number): vscode.Range {
  const from = Math.min(start, lastLine);
  const to = Math.min(start + count - 1, lastLine);
  return new vscode.Range(from, 0, to, 0);
}
