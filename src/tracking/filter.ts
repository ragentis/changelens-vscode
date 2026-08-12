import * as vscode from "vscode";
import type { ChangeLensConfig } from "../config";
import { IgnoreMatcher } from "./ignore";

/** Decides which workspace files are tracked and exposes the content-size limit. */
export class WorkspaceFilter {
  private matchers = new Map<string, IgnoreMatcher>();

  constructor(private config: ChangeLensConfig) {}

  /**
   * Builds matchers off to the side, then swaps them atomically. Events may arrive during
   * `.gitignore` reads; clearing in place would briefly mark every file out of scope and drop its
   * pending review.
   */
  async rebuild(config: ChangeLensConfig): Promise<void> {
    const matchers = new Map<string, IgnoreMatcher>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const matcher = new IgnoreMatcher();
      if (config.respectGitignore) {
        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(folder.uri, ".gitignore"),
          );
          matcher.addGitignore(Buffer.from(bytes).toString("utf8"));
        } catch {
          // A missing or unreadable file leaves only the explicit excludes.
        }
      }
      // Last match wins, so `.gitignore` cannot negate an explicit ChangeLens exclude.
      matcher.add(config.exclude);
      matchers.set(folder.uri.toString(), matcher);
    }

    // Publish the config with its matchers so events never combine old patterns with new limits.
    this.config = config;
    this.matchers = matchers;
  }

  isTracked(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return false;
    }
    const matcher = this.matchers.get(folder.uri.toString());
    if (!matcher) {
      return false;
    }
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    return !matcher.ignores(relative);
  }

  get maxFileSizeBytes(): number {
    return this.config.maxFileSizeKb * 1024;
  }

  /** Applies the on-disk byte limit to editor text, which has no file stat. */
  exceedsMaxSize(text: string): boolean {
    return Buffer.byteLength(text, "utf8") > this.maxFileSizeBytes;
  }
}
