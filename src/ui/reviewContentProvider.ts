import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { documentText, openDocument } from "../model";
import { stripBom } from "../core/text";
import { normalizeKey } from "../core/paths";
import { BASE_SCHEME, CURRENT_SCHEME, isReviewUri, toFileUri } from "./schemes";

export class ReviewContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: ChangeModel) {
    // Driven by what is open rather than by what is pending: a file that just left the review still
    // has an editor to refresh, and an unopened URI has no content to invalidate.
    this.subscription = model.onDidChange(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (isReviewUri(doc.uri)) {
          this._onDidChange.fire(doc.uri);
        }
      }
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const fileUri = toFileUri(uri);
    const file = this.model.get(normalizeKey(fileUri.fsPath));
    if (!file) {
      // The file left the pending list; keep showing its content instead of an empty editor. An
      // unsaved buffer wins over disk, or a revert applied as a workspace edit would read as undone.
      const open = openDocument(fileUri);
      if (open) {
        return documentText(open);
      }
      try {
        return stripBom(Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8"));
      } catch {
        return "";
      }
    }
    if (uri.scheme === BASE_SCHEME) {
      return file.baselineText;
    }
    if (uri.scheme === CURRENT_SCHEME) {
      return file.currentText;
    }
    return file.unified ? file.unified.lines.join(file.eol) : file.currentText;
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChange.dispose();
  }
}
