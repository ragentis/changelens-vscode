import * as vscode from "vscode";
import { normalizeKey } from "../core/paths";
import { stripBom } from "../core/text";

/** VS Code keeps the byte order mark out of the document model; strip it so both agree. */
export function documentText(doc: vscode.TextDocument): string {
  return stripBom(doc.getText());
}

/**
 * Finds an open buffer by normalized path and scheme. Casing may differ, while a review document
 * can share the file's path and must not stand in for it.
 */
export function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const target = normalizeKey(uri.fsPath);
  return vscode.workspace.textDocuments.find(
    (doc) =>
      doc.uri.scheme === uri.scheme && !doc.isClosed && normalizeKey(doc.uri.fsPath) === target,
  );
}

/**
 * Builds a line replacement whose range and text agree on EOL ownership, including EOF where no
 * following line can anchor the range.
 */
export function replaceLines(
  doc: vscode.TextDocument,
  startLine: number,
  lineCount: number,
  lines: string[],
): { range: vscode.Range; text: string } {
  const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const joined = lines.join(eol);

  // An EOF append needs a leading terminator to get past its anchor line.
  if (startLine >= doc.lineCount) {
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    return {
      range: new vscode.Range(end, end),
      text: lines.length === 0 ? "" : eol + joined,
    };
  }

  // A tail edit ends at the last line, so its replacement carries no trailing terminator.
  const endLine = startLine + lineCount;
  if (endLine >= doc.lineCount) {
    // Tail deletion also takes the preceding terminator; otherwise a trailing empty line survives.
    const start =
      lines.length === 0 && startLine > 0
        ? doc.lineAt(startLine - 1).range.end
        : new vscode.Position(startLine, 0);
    return {
      range: new vscode.Range(start, doc.lineAt(doc.lineCount - 1).range.end),
      text: joined,
    };
  }

  return {
    range: new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, 0)),
    text: lines.length === 0 ? "" : joined + eol,
  };
}

export function wholeRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
}
