import type { PendingFile } from "./pendingFile";

/** Last disk content and BOM; editor buffers do not expose the current file's BOM. */
export interface DiskText {
  text: string;
  hadBom: boolean | undefined;
}

/** Co-locates file state so rename and deletion move one record instead of synchronizing maps. */
interface TrackedFile {
  /** Text as the model last saw it, whether that came from an editor buffer or from disk. */
  current?: string;
  disk?: DiskText;
  /** The reviewable change, present only while the file has one. */
  pending?: PendingFile;
}

/** Stores a record only while it still contains current, disk, or pending state. */
export class TrackedFiles {
  private readonly records = new Map<string, TrackedFile>();
  /**
   * Cached sorted snapshot, replaced when pending state changes. Replacement lets a bulk action
   * keep iterating its complete original snapshot while removing files from current state.
   */
  private sorted: readonly PendingFile[] | undefined;

  keys(): string[] {
    return [...this.records.keys()];
  }

  pending(key: string): PendingFile | undefined {
    return this.records.get(key)?.pending;
  }

  current(key: string): string | undefined {
    return this.records.get(key)?.current;
  }

  disk(key: string): DiskText | undefined {
    return this.records.get(key)?.disk;
  }

  /** Every pending review, in a stable order the UI can render directly. */
  allPending(): readonly PendingFile[] {
    if (!this.sorted) {
      const pending: PendingFile[] = [];
      for (const record of this.records.values()) {
        if (record.pending) {
          pending.push(record.pending);
        }
      }

      this.sorted = pending.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
    }
    return this.sorted;
  }

  hasPending(): boolean {
    for (const record of this.records.values()) {
      if (record.pending) {
        return true;
      }
    }
    return false;
  }

  setCurrent(key: string, text: string): void {
    this.record(key).current = text;
  }

  /** Records `text` only if nothing is known yet, which is all a document opening proves. */
  setCurrentIfUnknown(key: string, text: string): void {
    const record = this.record(key);
    record.current ??= text;
  }

  setDisk(key: string, disk: DiskText): void {
    this.record(key).disk = disk;
  }

  setPending(key: string, pending: PendingFile): void {
    this.record(key).pending = pending;
    this.sorted = undefined;
  }

  /** Drops the pending review, and the record with it once nothing else is left to remember. */
  removePending(key: string): void {
    const record = this.records.get(key);
    if (!record?.pending) {
      return;
    }
    delete record.pending;
    this.sorted = undefined;

    if (record.current === undefined && record.disk === undefined) {
      this.records.delete(key);
    }
  }

  /** Forgets what the file contained without discarding a review that still stands. */
  forgetContent(key: string): void {
    const record = this.records.get(key);
    if (!record) {
      return;
    }
    delete record.current;
    delete record.disk;

    if (record.pending === undefined) {
      this.records.delete(key);
    }
  }

  /** Carries a record to a new key. The review is left behind: it is re-derived under the new name. */
  rename(oldKey: string, newKey: string): void {
    const record = this.records.get(oldKey);
    if (!record) {
      return;
    }

    this.records.delete(oldKey);
    delete record.pending;
    this.records.set(newKey, record);
    this.sorted = undefined;
  }

  delete(key: string): void {
    if (this.records.delete(key)) {
      this.sorted = undefined;
    }
  }

  clear(): void {
    this.records.clear();
    this.sorted = undefined;
  }

  private record(key: string): TrackedFile {
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }

    const created: TrackedFile = {};
    this.records.set(key, created);
    return created;
  }
}
