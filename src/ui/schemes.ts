import type * as vscode from "vscode";
import { normalizeKey } from "../core/paths";

/**
 * The virtual document schemes the review serves, and the URI arithmetic around them. Separate from
 * the provider because commands and context keys resolve these URIs without ever serving content.
 */

export const BASE_SCHEME = "changelens-base";
export const CURRENT_SCHEME = "changelens-current";
export const REVIEW_SCHEME = "changelens-review";

export const REVIEW_SCHEMES = [BASE_SCHEME, CURRENT_SCHEME, REVIEW_SCHEME];

export function toReviewUri(scheme: string, fileUri: vscode.Uri): vscode.Uri {
  return fileUri.with({ scheme, query: "" });
}

export function toFileUri(reviewUri: vscode.Uri): vscode.Uri {
  return reviewUri.with({ scheme: "file", query: "" });
}

export function isReviewUri(uri: vscode.Uri): boolean {
  return REVIEW_SCHEMES.includes(uri.scheme);
}

/** Resolves any review or file URI back to the tracked file key. */
export function fileKeyOf(uri: vscode.Uri): string {
  return normalizeKey((isReviewUri(uri) ? toFileUri(uri) : uri).fsPath);
}
