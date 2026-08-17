import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import type { LineSpan } from "./hunkGeometry";
import { clampSpan, placeHunks } from "./hunkGeometry";
import { fileKeyOf, isReviewUri, REVIEW_SCHEME } from "./schemes";

const MARKER_COLOR = new vscode.ThemeColor("changelens.deletedLineMarker");
const LABEL_COLOR = new vscode.ThemeColor("changelens.deletedLineMarkerForeground");

/** Past the end of any line, so the label attaches after the text and the hover reaches it. */
const LINE_END = Number.MAX_SAFE_INTEGER;

/** Enough of a deletion to recognise it; the review document holds the whole of it. */
const HOVER_LINE_LIMIT = 20;

/**
 * `textDecoration` is written into the rule verbatim, and it is the only attachment field that
 * reaches font size. Smaller than the code is what keeps the label from reading as another word
 * of it.
 */
const LABEL_CSS = "none; font-size: 0.85em;";

const MARKER_SIDES = ["above", "below"] as const;

/**
 * Which side of the marked line the deleted lines were on. Nearly always above it, since a marker
 * goes on the line the deletion ran into; a deletion off the end of the file has no such line, so
 * it is marked on the last line there is and drawn below it instead.
 */
type MarkerSide = (typeof MARKER_SIDES)[number];

const ARROW: Record<MarkerSide, string> = { above: "↑", below: "↓" };

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

  private readonly deletionMarker: Record<MarkerSide, vscode.TextEditorDecorationType> = {
    above: markerType("above"),
    below: markerType("below"),
  };

  /**
   * The label is its own type because it is anchored to the end of the marked line rather than to
   * all of it, which is what keeps the hover on the label instead of on the whole line.
   */
  private readonly deletionLabel = vscode.window.createTextEditorDecorationType({});

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
    for (const side of MARKER_SIDES) {
      editor.setDecorations(this.deletionMarker[side], []);
    }
    editor.setDecorations(this.deletionLabel, []);
  }

  private render(editor: vscode.TextEditor): void {
    const scheme = editor.document.uri.scheme;
    if (scheme !== REVIEW_SCHEME && (scheme !== "file" || !this.model.config.decorateEditor)) {
      this.clear(editor);
      return;
    }
    const file = this.model.get(fileKeyOf(editor.document.uri));
    const lastLine = Math.max(editor.document.lineCount - 1, 0);
    const addedRanges: vscode.Range[] = [];
    const deletedRanges: vscode.Range[] = [];
    const markers: Record<MarkerSide, vscode.Range[]> = { above: [], below: [] };
    const labels: vscode.DecorationOptions[] = [];

    placeHunks(file, scheme).forEach(({ removed, added, block }, index) => {
      if (removed.count > 0) {
        deletedRanges.push(toRange(removed, lastLine));
      }
      if (added.count > 0) {
        addedRanges.push(toRange(added, lastLine));
      }
      // A block the working file shows as neither: the lines it removed live only in the baseline.
      if (removed.count === 0 && added.count === 0) {
        const lines = file?.hunks[index]?.baseLines ?? [];
        const { first } = clampSpan(block, lastLine);
        const side: MarkerSide = block.start > lastLine ? "below" : "above";
        markers[side].push(new vscode.Range(first, 0, first, 0));
        labels.push(deletionLabel(editor.document, first, lines, side));
      }
    });

    editor.setDecorations(this.added, addedRanges);
    editor.setDecorations(this.deleted, deletedRanges);
    for (const side of MARKER_SIDES) {
      editor.setDecorations(this.deletionMarker[side], markers[side]);
    }
    editor.setDecorations(this.deletionLabel, labels);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.added.dispose();
    this.deleted.dispose();
    for (const side of MARKER_SIDES) {
      this.deletionMarker[side].dispose();
    }
    this.deletionLabel.dispose();
  }
}

function markerType(side: MarkerSide): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: MARKER_COLOR,
    borderWidth: side === "above" ? "2px 0 0 0" : "0 0 2px 0",
    borderStyle: "solid",
    overviewRulerColor: MARKER_COLOR,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
}

function toRange(span: LineSpan, lastLine: number): vscode.Range {
  const { first, last } = clampSpan(span, lastLine);
  return new vscode.Range(first, 0, last, 0);
}

function deletionLabel(
  document: vscode.TextDocument,
  line: number,
  lines: string[],
  side: MarkerSide,
): vscode.DecorationOptions {
  // Anchored to the end of the line rather than to all of it, so the label follows the code and
  // the hover belongs to the label instead of to every column of the line it is written on.
  const end = Math.max(document.lineAt(line).text.length - 1, 0);
  return {
    range: new vscode.Range(line, end, line, LINE_END),
    hoverMessage: deletedHover(lines, document.languageId),
    renderOptions: {
      after: {
        // The label shares its line with the marker, so the arrow says which edge it was drawn on.
        contentText: `${ARROW[side]} ${countLabel(lines.length)}`,
        color: LABEL_COLOR,
        margin: "0 0 0 1.5em",
        textDecoration: LABEL_CSS,
      },
    },
  };
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"} deleted`;
}

function deletedHover(lines: string[], languageId: string): vscode.MarkdownString {
  const shown = lines.slice(0, HOVER_LINE_LIMIT);
  const hover = new vscode.MarkdownString(
    `**ChangeLens** — ${countLabel(lines.length)}\n\n${fence(shown.join("\n"), languageId)}`,
  );
  if (lines.length > shown.length) {
    hover.appendMarkdown(`\n\n${lines.length - shown.length} more are in the review document.`);
  }
  return hover;
}

/** Deleted text can hold a fence of its own, so the wrapper has to outrun the longest run in it. */
function fence(code: string, languageId: string): string {
  const runs = code.match(/`+/g) ?? [];
  const ticks = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${ticks}${languageId}\n${code}\n${ticks}`;
}
