import type { PendingFile } from "./pendingFile";

/**
 * Identity of the last disk content, and its BOM; editor buffers do not expose the current file's
 * BOM. Only equality is ever asked of the content, so a digest stands in for it.
 */
export interface DiskText {
  digest: string;
  hadBom: boolean | undefined;
}

/** Co-locates file state so rename and deletion move one record instead of synchronizing maps. */
interface TrackedFile {
  /** Text as the model last saw it, whether that came from an editor buffer or from disk. */
  current?: string;
  disk?: DiskText;
  /**
   * The clean text a run of unsaved edits started from. Present only while the baseline holds
   * edits the buffer could still discard, so that a discard can fold them back out.
   */
  editedFrom?: string;
  /** The reviewable change, present only while the file has one. */
  pending?: PendingFile;
}

/** Stores a record only while it still contains some state. */
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

  editedFrom(key: string): string | undefined {
    return this.records.get(key)?.editedFrom;
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

  setEditedFrom(key: string, text: string): void {
    this.record(key).editedFrom = text;
  }

  /** Records where a run of unsaved edits began, unless an earlier edit of the run already did. */
  setEditedFromIfUnknown(key: string, text: string): void {
    const record = this.record(key);
    record.editedFrom ??= text;
  }

  /** The unsaved edits were saved or discarded, so there is nothing left to fold back out. */
  clearEditedFrom(key: string): void {
    const record = this.records.get(key);
    if (!record) {
      return;
    }
    delete record.editedFrom;
    this.dropIfEmpty(key, record);
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
    this.dropIfEmpty(key, record);
  }

  /**
   * Forgets what the file contained without discarding a review that still stands. Unsaved edits
   * belong to the buffer rather than the file, so where they began is kept for their discard.
   */
  forgetContent(key: string): void {
    const record = this.records.get(key);
    if (!record) {
      return;
    }
    delete record.current;
    delete record.disk;
    this.dropIfEmpty(key, record);
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

  private dropIfEmpty(key: string, record: TrackedFile): void {
    if (
      record.current === undefined &&
      record.disk === undefined &&
      record.editedFrom === undefined &&
      record.pending === undefined
    ) {
      this.records.delete(key);
    }
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
