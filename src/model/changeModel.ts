import * as vscode from "vscode";
import { normalizeKey } from "../core/paths";
import { type BaselineStore, matchesDisk } from "../storage";
import type { ChangeLensConfig, ReviewMode, ViewMode } from "../config";
import { BaselineCapture } from "./baselineCapture";
import { FileEvents } from "./fileEvents";
import type { StatResult } from "./fileState";
import type { DeferredEvent } from "./fileWork";
import { ModelContext } from "./modelContext";
import { PendingDeriver } from "./pendingDeriver";
import type { PendingFile } from "./pendingFile";
import { ReviewActions } from "./reviewActions";

/** Public model facade; its lifecycle chain serializes collaborators sharing one context. */
export class ChangeModel implements vscode.Disposable {
  private readonly context: ModelContext;
  private readonly deriver: PendingDeriver;
  private readonly capture: BaselineCapture;
  private readonly events: FileEvents;
  private readonly review: ReviewActions;
  /** Tail of the lifecycle chain, which is what keeps whole-model operations from overlapping. */
  private lifecycle: Promise<void> = Promise.resolve();
  /** Tail of the toggle chain, kept separate so a mode never queues behind baseline work. */
  private modeChange: Promise<void> = Promise.resolve();

  readonly onDidChange: vscode.Event<void>;

  ready = false;

  constructor(store: BaselineStore, viewModeState?: vscode.Memento) {
    this.context = new ModelContext(store, viewModeState);
    this.onDidChange = this.context.onDidChange;
    this.deriver = new PendingDeriver(this.context);
    this.capture = new BaselineCapture(this.context, () => {
      // The chain handles rejection; another failed retry announces itself like the first.
      void this.captureBaseline(false).catch(() => undefined);
    });
    this.events = new FileEvents(this.context, this.deriver, this.capture);
    this.review = new ReviewActions(this.context, this.deriver);
  }

  // ── what is pending ──────────────────────────────────────────────────────

  get config(): ChangeLensConfig {
    return this.context.config;
  }

  get files(): readonly PendingFile[] {
    return this.context.tracked.allPending();
  }

  get hasChanges(): boolean {
    return this.context.tracked.hasPending();
  }

  get(key: string): PendingFile | undefined {
    return this.context.tracked.pending(key);
  }

  getByUri(uri: vscode.Uri): PendingFile | undefined {
    return this.get(normalizeKey(uri.fsPath));
  }

  fire(): void {
    this.context.fire();
  }

  recompute(uri: vscode.Uri, silent = false): Promise<void> {
    return this.deriver.recompute(uri, silent);
  }

  // ── events from the workspace ────────────────────────────────────────────

  handleDiskWrite(uri: vscode.Uri): Promise<void> {
    return this.events.handleDiskWrite(uri);
  }

  handleDiskDelete(uri: vscode.Uri): Promise<void> {
    return this.events.handleDiskDelete(uri);
  }

  handleBufferChange(doc: vscode.TextDocument): Promise<void> {
    return this.events.handleBufferChange(doc);
  }

  handleSave(doc: vscode.TextDocument): Promise<void> {
    return this.events.handleSave(doc);
  }

  handleDocumentOpened(doc: vscode.TextDocument): void {
    this.events.handleDocumentOpened(doc);
  }

  handleEditorCreate(uris: readonly vscode.Uri[]): Promise<void> {
    return this.events.handleEditorCreate(uris);
  }

  handleEditorDelete(uris: readonly vscode.Uri[]): Promise<void> {
    return this.events.handleEditorDelete(uris);
  }

  handleEditorRename(moves: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    return this.events.handleEditorRename(moves);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Serializes operations that rewrite the store and tracked set as a unit. Joining the operation
   * also makes `drain` and shutdown wait for the lifecycle tail. Without serialization, rescope
   * could drop a root while capture later persists entries for it as absolute paths.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(work);
    // The chain must stay resolved: a rejected tail would skip every operation queued behind it.
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return this.context.work.join(run);
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      // Load roots first so the index can distinguish retained roots from newly opened ones.
      await this.context.applyConfig();
      await this.context.store.load();

      if (this.context.store.initialized) {
        await this.capture.baselineArrivedRoots();
        await this.runReconcile(true);
      } else {
        await this.runCapture(true);
      }

      // A loaded baseline can exceed the limit without any root arriving.
      this.context.warnIfCrowded();
      this.ready = true;
    });
    this.fire();
    void this.context.store.collectGarbage();
  }

  /**
   * Serializes the mode toggles on a chain of their own: they carry no baseline work, so they must
   * not wait behind a capture, but each one still has to read the mode the previous one published.
   */
  private queueMode<T>(work: () => Promise<T>): Promise<T> {
    const run = this.modeChange.then(work);
    // As with the lifecycle chain, a rejected tail would strand every toggle queued behind it.
    this.modeChange = run.then(
      () => undefined,
      () => undefined,
    );
    // Joined so a window closing on a toggle drains its write instead of dropping the choice.
    return this.context.work.join(run);
  }

  setViewMode(mode: ViewMode): Promise<void> {
    return this.queueMode(async () => {
      if (this.config.viewMode === mode) {
        return;
      }
      await this.context.setViewMode(mode);
      this.fire();
    });
  }

  /**
   * Flips inside the chain and reports what it landed on, so two rapid toggles cannot both read
   * the same mode and pick the same successor. Nothing on screen depends on it, so it never fires.
   */
  toggleReviewMode(): Promise<ReviewMode> {
    return this.queueMode(async () => {
      const next: ReviewMode = this.config.reviewMode === "unified" ? "diffEditor" : "unified";
      await this.context.setReviewMode(next);
      return next;
    });
  }

  reloadConfig(): Promise<void> {
    return this.exclusive(async () => {
      await this.context.applyConfig();
      // A lower limit can cross the threshold without changing the baseline.
      this.context.warnIfCrowded();
    });
  }

  /**
   * Re-evaluates scope after settings or workspace folders change.
   *
   * Newly included files enter the baseline instead of appearing as additions. Excluded files
   * leave the review but keep their baselines, so re-including them does not accept hidden changes.
   */
  rescope(): Promise<void> {
    return this.exclusive(async () => {
      await this.context.applyConfig();
      await this.capture.baselineUntracked();
      await this.runReconcile(true);
    });
  }

  /**
   * Captures the current workspace as the new baseline. Watcher events are deferred until it is
   * complete so pending state is never rebuilt against a partial snapshot.
   */
  captureBaseline(initial: boolean): Promise<void> {
    // Deferral has one shared map; overlapping captures could replace or disable each other's map.
    return this.exclusive(() => this.runCapture(initial));
  }

  private async runCapture(initial: boolean): Promise<void> {
    const work = this.context.work;
    work.beginDeferring();
    let deferred: DeferredEvent[] = [];
    let failure: { error: unknown } | undefined;

    try {
      // Drain only file queues: this capture is joined, so draining all work would wait on itself.
      await work.drainFiles();
      await this.capture.captureAll(initial);
    } catch (error) {
      failure = { error };
    } finally {
      deferred = work.stopDeferring();
    }
    // Replay even after a failed capture, or changes made during it would be lost.
    for (const event of deferred) {
      await this.events.replay(event);
    }

    this.fire();

    if (failure) {
      this.capture.announceFailure(initial);
      throw failure.error;
    }
  }

  /**
   * Records what the given files are now, for {@link absorbGitRewrite} to verify against. Kept off
   * the lifecycle chain so the caller decides when it happens, which is what its value depends on.
   */
  snapshotDisk(uris: readonly vscode.Uri[]): Promise<Map<string, StatResult>> {
    return this.capture.snapshotDisk(uris);
  }

  /**
   * Adopts the given files as they are now, bypassing review. Only for writes Git made itself: the
   * caller has established which paths those are, and everything else stays pending.
   */
  absorbGitRewrite(
    uris: readonly vscode.Uri[],
    recorded: ReadonlyMap<string, StatResult>,
  ): Promise<void> {
    return this.exclusive(() => this.runAbsorb(uris, recorded));
  }

  private async runAbsorb(
    uris: readonly vscode.Uri[],
    recorded: ReadonlyMap<string, StatResult>,
  ): Promise<void> {
    const work = this.context.work;
    // Deferral keeps a write arriving mid-adoption from being derived against a half-moved baseline.
    work.beginDeferring();
    let deferred: DeferredEvent[] = [];
    let failure: { error: unknown } | undefined;

    try {
      await work.drainFiles();
      await this.capture.adoptGitWrites(uris, recorded);
    } catch (error) {
      failure = { error };
    } finally {
      deferred = work.stopDeferring();
    }
    // A write that landed while Git's work was being adopted is an external change like any other.
    for (const event of deferred) {
      await this.events.replay(event);
    }

    this.fire();

    if (failure) {
      throw failure.error;
    }
  }

  /**
   * Re-derives tracked files. `trustStat` speeds activation by skipping clean stat matches;
   * refresh disables it so stale stats cannot hide missed writes.
   */
  reconcile(trustStat = true): Promise<void> {
    return this.exclusive(() => this.runReconcile(trustStat));
  }

  private async runReconcile(trustStat: boolean): Promise<void> {
    const { store, reader, tracked } = this.context;
    const seen = new Set<string>();
    for (const uri of await this.context.listWorkspaceFiles()) {
      const key = normalizeKey(uri.fsPath);
      seen.add(key);

      const entry = trustStat ? store.entry(key) : undefined;
      if (entry) {
        const stat = await reader.stat(uri);
        if (stat.kind === "stat" && matchesDisk(entry, stat.stat)) {
          continue;
        }
      }

      await this.recompute(uri, true);
    }

    // Also settle missing or out-of-scope files; `seen` deduplicates the overlapping key sources.
    for (const key of [...store.keys(), ...tracked.keys()]) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const entry = store.entry(key);
      // Without a baseline or pending review, a tracked record has nothing left to derive.
      const uri = entry ? vscode.Uri.file(entry.path) : this.get(key)?.uri;
      if (uri) {
        await this.recompute(uri, true);
      }
    }

    this.fire();
  }

  /** Waits for started per-file and whole-model work before shutdown flushes the store. */
  drain(): Promise<void> {
    return this.context.work.drainAll();
  }

  // ── review actions ───────────────────────────────────────────────────────
  //
  // Review actions share the lifecycle chain with capture so neither observes partial store state;
  // joining them also puts their writes ahead of shutdown's drain and flush.

  /** Whether the review reflects a baseline that was actually finished. */
  get reviewable(): boolean {
    return this.context.store.initialized;
  }

  /**
   * Checks completeness on the lifecycle chain, after any capture queued ahead. A failed capture
   * can make unbaselined files look added, so allowing revert could delete user work. Commands
   * explain the refusal; this silent guard protects every other caller.
   */
  private reviewAction<T>(refused: T, work: () => Promise<T>): Promise<T> {
    return this.exclusive(() => (this.reviewable ? work() : Promise.resolve(refused)));
  }

  acceptFile(key: string): Promise<void> {
    return this.reviewAction<void>(undefined, () => this.review.acceptFile(key));
  }

  acceptHunk(key: string, signature: string): Promise<boolean> {
    return this.reviewAction(false, () => this.review.acceptHunk(key, signature));
  }

  revertHunk(key: string, signature: string): Promise<boolean> {
    return this.reviewAction(false, () => this.review.revertHunk(key, signature));
  }

  revertFile(key: string): Promise<boolean> {
    return this.reviewAction(false, () => this.review.revertFile(key));
  }

  acceptAll(): Promise<void> {
    return this.reviewAction<void>(undefined, () => this.review.acceptAll());
  }

  revertAll(): Promise<string[]> {
    return this.reviewAction<string[]>([], () => this.review.revertAll());
  }

  dispose(): void {
    this.context.dispose();
  }
}
