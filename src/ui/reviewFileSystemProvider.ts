import * as vscode from "vscode";
import type { ChangeModel } from "../model";
import { documentText, openDocument } from "../model";
import { stripBom } from "../core/text";
import { normalizeKey } from "../core/paths";
import { BASE_SCHEME, CURRENT_SCHEME, isReviewUri, toFileUri } from "./schemes";

/**
 * Serves the review documents as a read-only file system.
 *
 * A content provider would be the smaller fit, but it cannot make the document read-only. VS Code
 * derives that from the file system provider registered for the scheme, and a content provider
 * registers none, so every recomputation settles on writable: the review accepts typing and Ctrl+S
 * falls through to Save As. Registering here with `isReadonly` answers that question the same way
 * on each of those paths.
 */
export class ReviewFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;
  private readonly subscription: vscode.Disposable;
  /**
   * Strictly increasing rather than a plain clock reading. The editor reloads only when the stat
   * moves, so two changes landing in the same millisecond would leave stale text on screen.
   */
  private mtime = Date.now();

  constructor(private readonly model: ChangeModel) {
    // Driven by what is open rather than by what is pending: a file that just left the review still
    // has an editor to refresh, and an unopened URI has no content to invalidate.
    this.subscription = model.onDidChange(() => {
      const open = vscode.workspace.textDocuments.filter((doc) => isReviewUri(doc.uri));
      if (open.length === 0) {
        return;
      }
      this.mtime = Math.max(Date.now(), this.mtime + 1);
      this._onDidChangeFile.fire(
        open.map((doc) => ({ type: vscode.FileChangeType.Changed, uri: doc.uri })),
      );
    });
  }

  watch(): vscode.Disposable {
    return { dispose: () => undefined };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.mtime,
      size: Buffer.byteLength(await this.text(uri), "utf8"),
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from(await this.text(uri), "utf8");
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    // Not a refusal to write: every review URI names a file, so there is no directory to list.
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  /**
   * Resolves a review URI to its text. Never throws: `stat` runs before every open, and a failure
   * there would surface as an error instead of the empty editor a missing baseline deserves.
   */
  async text(uri: vscode.Uri): Promise<string> {
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
    this._onDidChangeFile.dispose();
  }
}
