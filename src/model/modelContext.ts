import * as vscode from "vscode";
import type { BaselineStore } from "../storage";
import type { ChangeLensConfig, ReviewMode, ViewMode } from "../config";
import {
  excludeGlob,
  normalizeReviewMode,
  normalizeViewMode,
  readConfig,
  REVIEW_MODE_STATE_KEY,
  VIEW_MODE_STATE_KEY,
} from "../config";
import { WorkspaceFilter } from "../tracking/filter";
import { FileStateReader } from "./fileState";
import { FileWorkQueue } from "./fileWork";
import { TrackedFiles } from "./trackedFiles";

/** Coalesces bursts of checks without suppressing later warnings. */
const WARNING_INTERVAL_MS = 60_000;

/**
 * Shared model state and workspace access. Capture, events, derivation, and review intentionally
 * operate on the same tracked set, store, reader, and filter.
 */
export class ModelContext implements vscode.Disposable {
  readonly tracked = new TrackedFiles();
  readonly work = new FileWorkQueue();
  readonly filter: WorkspaceFilter;
  readonly reader: FileStateReader;
  /** Replaced wholesale by {@link applyConfig}, so it is read through the context, never copied. */
  config: ChangeLensConfig;

  private readonly emitter = new vscode.EventEmitter<void>();
  private lastWarning = 0;

  readonly onDidChange = this.emitter.event;

  /**
   * The live answer to "what did the user toggle", with {@link toggleState} only persisting it.
   * Holding it here keeps a toggle authoritative while a config reload is mid-flight, and keeps
   * one working when no storage was supplied at all.
   */
  private viewModeOverride: ViewMode | undefined;
  private reviewModeOverride: ReviewMode | undefined;

  constructor(
    readonly store: BaselineStore,
    private readonly toggleState?: vscode.Memento,
  ) {
    const viewMode = toggleState?.get<string>(VIEW_MODE_STATE_KEY);
    const reviewMode = toggleState?.get<string>(REVIEW_MODE_STATE_KEY);
    this.viewModeOverride = viewMode === undefined ? undefined : normalizeViewMode(viewMode);
    this.reviewModeOverride =
      reviewMode === undefined ? undefined : normalizeReviewMode(reviewMode);

    this.config = this.read();
    this.filter = new WorkspaceFilter(this.config);
    this.reader = new FileStateReader(store, this.filter);
  }

  /** A stored toggle wins over its configured default, the way the SCM view resolves its mode. */
  private read(): ChangeLensConfig {
    const config = readConfig();
    return { ...config, ...this.toggles(config) };
  }

  /** The two values a toggle owns, resolved against the defaults they fall back to. */
  private toggles(defaults: ChangeLensConfig): Pick<ChangeLensConfig, "viewMode" | "reviewMode"> {
    return {
      viewMode: this.viewModeOverride ?? defaults.viewMode,
      reviewMode: this.reviewModeOverride ?? defaults.reviewMode,
    };
  }

  /**
   * Both setters publish only once the write lands. Publishing first would leave the model ahead
   * of the view when the write rejects, because the caller never reaches the event that redraws it.
   */
  async setViewMode(mode: ViewMode): Promise<void> {
    await this.toggleState?.update(VIEW_MODE_STATE_KEY, mode);
    this.viewModeOverride = mode;
    this.config = { ...this.config, viewMode: mode };
  }

  async setReviewMode(mode: ReviewMode): Promise<void> {
    await this.toggleState?.update(REVIEW_MODE_STATE_KEY, mode);
    this.reviewModeOverride = mode;
    this.config = { ...this.config, reviewMode: mode };
  }

  fire(): void {
    this.emitter.fire();
  }

  /** Rebuilds the filter before publishing config, so events cannot mix old scope with new limits. */
  async applyConfig(): Promise<void> {
    const config = this.read();
    this.store.setRoots(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    );
    await this.filter.rebuild(config);
    // A toggle can land during the rebuild, and being stored state rather than a setting it raises
    // no configuration event that would bring us back here to pick it up. Everything else stays
    // paired with the snapshot the filter was just rebuilt against.
    this.config = { ...config, ...this.toggles(config) };
  }

  /**
   * Warns when a supplied candidate count, or the stored baseline size, exceeds the limit. Capture
   * passes its existing listing to warn before reading every file; repeated checks are throttled.
   */
  warnIfCrowded(count = this.store.size): void {
    const limit = this.config.maxTrackedFiles;
    if (count <= limit || Date.now() - this.lastWarning < WARNING_INTERVAL_MS) {
      return;
    }

    this.lastWarning = Date.now();
    void vscode.window.showWarningMessage(
      `ChangeLens is tracking ${count} files, above the configured limit of ${limit}. Add exclude patterns to keep the baseline small.`,
    );
  }

  /** Every in-scope file of every open folder. */
  async listWorkspaceFiles(): Promise<vscode.Uri[]> {
    const glob = excludeGlob(this.config.exclude);
    const found = await vscode.workspace.findFiles("**/*", glob);
    return found.filter((uri) => this.filter.isTracked(uri));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
