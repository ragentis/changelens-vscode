import type * as vscode from "vscode";
import { normalizeKey } from "../core/paths";

/**
 * Capture replay intent. `adopt` and `forget` preserve editor file-operation semantics that a
 * plain recompute would lose, such as a new file reappearing as an external addition.
 */
export type DeferredEvent = { uri: vscode.Uri; kind: "recompute" | "adopt" | "forget" };

/**
 * Serializes per-file work and defers events during capture. Queue state stays separate from file
 * records because it describes transient work and disappears when drained.
 */
export class FileWorkQueue {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly joined = new Set<Promise<unknown>>();
  private deferred: Map<string, DeferredEvent> | undefined;

  /** Runs `work` once everything already queued for `key` has settled. */
  enqueue(key: string, work: () => Promise<void> | void): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();

    // Continue after either outcome so one failed item cannot stall the key.
    const next: Promise<void> = previous.then(work, work).finally(() => {
      // Only the current tail clears the entry; later work has already replaced this promise.
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    });

    this.queues.set(key, next);
    return next;
  }

  /** Adds whole-model work to {@link drainAll} while returning its original rejecting promise. */
  join<T>(work: Promise<T>): Promise<T> {
    const settled: Promise<unknown> = work.then(
      () => this.joined.delete(settled),
      () => this.joined.delete(settled),
    );
    this.joined.add(settled);
    return work;
  }

  /** How much work is still in flight. Exposed so the bookkeeping stays observable. */
  get outstanding(): number {
    return this.queues.size + this.joined.size;
  }

  /** Settles the per-file work already started, without blocking new work. */
  async drainFiles(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.catch(() => undefined)));
  }

  /**
   * Settles per-file and joined work. Capture uses {@link drainFiles} because it is itself joined;
   * calling this from inside capture would wait on itself.
   */
  async drainAll(): Promise<void> {
    await Promise.all([this.drainFiles(), ...this.joined]);
  }

  beginDeferring(): void {
    this.deferred = new Map();
  }

  /** Stops parking events and hands back what accumulated, in arrival order. */
  stopDeferring(): DeferredEvent[] {
    const parked = [...(this.deferred?.values() ?? [])];
    this.deferred = undefined;
    return parked;
  }

  /** Returns true when the event was parked for replay because a capture is in progress. */
  defer(uri: vscode.Uri, kind: DeferredEvent["kind"] = "recompute"): boolean {
    if (!this.deferred) {
      return false;
    }

    const key = normalizeKey(uri.fsPath);

    // A later plain write must not erase the fact that the user created or removed the file.
    if (kind !== "recompute" || !this.deferred.has(key)) {
      this.deferred.set(key, { uri, kind });
    }
    return true;
  }
}
