import * as vscode from "vscode";

/** Every `changelens.*` setting, read as one snapshot. Tracking, the model, and the UI each own a part. */
export interface ChangeLensConfig {
  respectGitignore: boolean;
  exclude: string[];
  maxFileSizeKb: number;
  maxTrackedFiles: number;
  showCodeLensInEditor: boolean;
  decorateEditor: boolean;
  viewMode: ViewMode;
  reviewMode: ReviewMode;
  autoReveal: boolean;
}

export type ViewMode = "tree" | "list";
export type ReviewMode = "unified" | "diffEditor";

/** Workspace-state keys holding the toolbar toggles, which outrank their `default*` settings. */
export const VIEW_MODE_STATE_KEY = "changelens.viewMode";
export const REVIEW_MODE_STATE_KEY = "changelens.reviewMode";

export function normalizeViewMode(value: unknown): ViewMode {
  return value === "list" ? "list" : "tree";
}

export function normalizeReviewMode(value: unknown): ReviewMode {
  return value === "diffEditor" ? "diffEditor" : "unified";
}

/** Must stay in sync with the `changelens.exclude` default in package.json. */
export const DEFAULT_EXCLUDE: readonly string[] = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/*.lock",
  "**/package-lock.json",
];

/** A limit of zero or less would silently stop the extension from tracking anything. */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readConfig(): ChangeLensConfig {
  const config = vscode.workspace.getConfiguration("changelens");
  return {
    respectGitignore: config.get("respectGitignore", true),
    exclude: config.get<string[]>("exclude", [...DEFAULT_EXCLUDE]),
    maxFileSizeKb: positive(config.get("maxFileSizeKb", 512), 512),
    maxTrackedFiles: positive(config.get("maxTrackedFiles", 20000), 20000),
    showCodeLensInEditor: config.get("showCodeLensInEditor", true),
    decorateEditor: config.get("decorateEditor", true),
    viewMode: normalizeViewMode(config.get<ViewMode>("defaultViewMode", "tree")),
    reviewMode: normalizeReviewMode(config.get<ReviewMode>("defaultReviewMode", "unified")),
    autoReveal: config.get("autoReveal", true),
  };
}

/** Renders the exclude patterns as the single glob `findFiles` accepts. */
export function excludeGlob(patterns: string[]): string | undefined {
  if (!patterns.length) {
    return undefined;
  }
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}
