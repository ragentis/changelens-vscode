import * as vscode from "vscode";
import { isReviewUri } from "./schemes";

/**
 * Retags review documents to a mirror language, so no validator reports errors about code that is
 * fine on disk.
 *
 * Two things make a review document look broken to a language server. Its scheme is not `file`, so
 * the document lands outside every project and relative imports stop resolving. And the unified view
 * keeps deleted lines above their replacement, so a hunk over a line that opens a block leaves the
 * buffer unparseable from there down. Neither says anything about the file being reviewed.
 *
 * The mirror languages contribute nothing but the grammar of the language they stand in for, so
 * highlighting survives while the language id matches no validator. Languages without a mirror keep
 * their own id, errors included.
 *
 * Which languages are worth a mirror was measured rather than assumed: most language servers select
 * documents by `{ scheme: "file" }` and never see a review at all. The ones below are the servers
 * that answered. A mirror for a language another extension owns is safe, because the editor only
 * reports that language id when the extension contributing it is installed, which is also the
 * extension whose grammar the mirror includes.
 */

/** Exported so a test can hold the manifest to it: every target needs a language and a grammar. */
export const MIRRORS = new Map([
  ["typescript", "changelens-typescript"],
  ["typescriptreact", "changelens-typescriptreact"],
  ["javascript", "changelens-javascript"],
  ["javascriptreact", "changelens-javascriptreact"],
  ["json", "changelens-json"],
  ["jsonc", "changelens-jsonc"],
  ["css", "changelens-css"],
  ["scss", "changelens-scss"],
  ["less", "changelens-less"],
  ["vue", "changelens-vue"],
  ["mdx", "changelens-mdx"],
  ["yaml", "changelens-yaml"],
  ["dockercompose", "changelens-dockercompose"],
  ["github-actions-workflow", "changelens-github-actions-workflow"],
]);

export function mirrorReviewLanguages(): vscode.Disposable {
  for (const doc of vscode.workspace.textDocuments) {
    void retag(doc);
  }
  return vscode.workspace.onDidOpenTextDocument((doc) => void retag(doc));
}

async function retag(doc: vscode.TextDocument): Promise<void> {
  if (!isReviewUri(doc.uri)) {
    return;
  }
  const mirror = MIRRORS.get(doc.languageId);
  if (!mirror) {
    return;
  }
  try {
    await vscode.languages.setTextDocumentLanguage(doc, mirror);
  } catch {
    // Retagging closes and reopens the document, so a review that was closed in between rejects here
    // with nothing left to retag.
  }
}
