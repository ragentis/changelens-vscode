import * as vscode from "vscode";
import { normalizeKey } from "../core/paths";
import type { ChangeModel } from "../model";
import {
  changedPaths,
  type CommitRange,
  describeMovement,
  type GitHead,
  pathsMatchingHead,
} from "./gitMovement";

/**
 * What happens when Git rewrites the workspace behind the extension's back. Kept out of the
 * activation wiring so the decisions can be exercised without an extension host.
 */

/** Where each folder's last observed HEAD is remembered, so a pull during a reload is still seen. */
const GIT_HEADS_STATE_KEY = "changelens.gitHeads";

export const KEEP_PENDING = "Keep Pending Changes";
export const RESET_BASELINE = "Reset Baseline";

export const BRANCH_CHANGED_PROMPT =
  "The Git branch changed while ChangeLens has pending changes. Reset the baseline to the current workspace?";

export const BRANCH_CHANGED_DETAIL =
  "Keeping the baseline will show every file rewritten by the branch switch as a pending change.";

/**
 * Resets the whole baseline for a branch switch. Only reachable without a reflog, which is the one
 * case where the rewritten files cannot be named and the choice has to be all or nothing.
 */
export async function resetForBranchSwitch(model: ChangeModel): Promise<void> {
  if (!model.hasChanges) {
    await model.captureBaseline(false);
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    BRANCH_CHANGED_PROMPT,
    { modal: true, detail: BRANCH_CHANGED_DETAIL },
    RESET_BASELINE,
    KEEP_PENDING,
  );
  if (answer === RESET_BASELINE) {
    await model.captureBaseline(false);
  }
}

function readHeads(state: vscode.Memento | undefined): Record<string, GitHead> {
  const stored = state?.get<unknown>(GIT_HEADS_STATE_KEY);
  if (typeof stored !== "object" || stored === null) {
    return {};
  }

  // Stored state survives downgrades and hand edits, so nothing about its shape is guaranteed.
  const entries: [string, unknown][] = Object.entries(stored);
  const heads: Record<string, GitHead> = {};
  for (const [folder, head] of entries) {
    if (typeof head === "object" && head !== null && "sha" in head && "ref" in head) {
      const { sha, ref } = head;
      if (typeof sha === "string" && typeof ref === "string") {
        heads[folder] = { sha, ref };
      }
    }
  }
  return heads;
}

/**
 * Folds Git's own writes into the baseline instead of reporting them as agent changes.
 *
 * A pull, merge, rebase, or reset rewrites part of the working tree. Those files are named by
 * comparing the two commits, so everything Git did not touch stays under review.
 */
export class GitSync {
  private readonly heads: Record<string, GitHead>;
  /** In-flight pass per folder, which is what keeps two triggers from handling one movement. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly model: ChangeModel,
    private readonly state?: vscode.Memento,
  ) {
    this.heads = readHeads(state);
  }

  /** Catches up every folder, which is how a pull made while the window was closed is found. */
  async syncAll(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.sync(folder.uri.fsPath);
    }
  }

  /**
   * Handles one folder's movement, one at a time. Activation's catch-up and a watcher event can
   * arrive together, and without this both would read the same recorded HEAD, handle the same
   * movement twice, and raise its dialog twice.
   */
  sync(folder: string): Promise<void> {
    const key = normalizeKey(folder);
    const run = () => this.syncFolder(folder, key);
    const previous = this.running.get(key) ?? Promise.resolve();

    // Continue after either outcome so one failed pass cannot stall the folder.
    const next: Promise<void> = previous.then(run, run).finally(() => {
      if (this.running.get(key) === next) {
        this.running.delete(key);
      }
    });

    this.running.set(key, next);
    return next;
  }

  private async syncFolder(folder: string, key: string): Promise<void> {
    // Without a finished baseline there is nothing to absorb into and no review to protect.
    if (!this.model.ready) {
      return;
    }

    const movement = await describeMovement(folder, this.heads[key]);
    if (movement.kind === "unavailable") {
      return;
    }

    let settled = false;
    try {
      if (movement.kind === "rewrite") {
        settled = await this.absorb(folder, movement.ranges);
      } else {
        if (movement.kind === "unknown" && movement.branchSwitch) {
          await resetForBranchSwitch(this.model);
        }
        // A movement along the same branch that no reflog describes is left alone deliberately. A
        // pull and a commit of unreviewed work leave identical evidence behind — HEAD moved, the
        // file differs from the baseline, the working tree matches HEAD — so guessing would
        // eventually accept an agent's work on the user's behalf.
        settled = true;
      }
    } finally {
      // Recorded even after the user refuses, or the same movement would be raised forever. Not
      // recorded when the movement was never settled — Git could not say which files it owns, or
      // the adoption failed — so a later movement gets another attempt at it.
      if (settled) {
        await this.remember(key, movement.head);
      }
    }
  }

  /**
   * Adopts without asking, because the paths reaching this point are the ones Git owns. Git
   * refuses to overwrite a locally modified file, so an agent's unaccepted write is never among
   * them unless it landed after Git finished — and the two checks below are ordered to catch that.
   *
   * The snapshot is taken first and the ownership check second, so a write has nowhere to land: one
   * before the check leaves the file dirty and drops it here, one after it moves the file off the
   * stat the adoption verifies. Recording after the check instead would record the write itself.
   */
  private async absorb(folder: string, ranges: readonly CommitRange[]): Promise<boolean> {
    const candidates = await changedPaths(folder, ranges);
    if (candidates.length === 0) {
      return true;
    }

    const recorded = await this.model.snapshotDisk(candidates.map((p) => vscode.Uri.file(p)));
    const owned = await pathsMatchingHead(folder, candidates);
    if (owned === undefined) {
      return false;
    }

    if (owned.length > 0) {
      await this.model.absorbGitRewrite(
        owned.map((fsPath) => vscode.Uri.file(fsPath)),
        recorded,
      );
    }
    return true;
  }

  private async remember(key: string, head: GitHead): Promise<void> {
    const known = this.heads[key];
    if (known?.sha === head.sha && known.ref === head.ref) {
      return;
    }

    this.heads[key] = head;
    await this.state?.update(GIT_HEADS_STATE_KEY, this.heads);
  }
}
