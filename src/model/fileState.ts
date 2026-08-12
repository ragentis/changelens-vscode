import * as vscode from "vscode";
import type { DiskStat, OpaqueKind } from "../core/files";
import { normalizeKey } from "../core/paths";
import { BOM, decodeUtf8, looksBinary, stripBom } from "../core/text";
import type { BaselineStore } from "../storage";
import type { WorkspaceFilter } from "../tracking/filter";
import { documentText, openDocument } from "./documents";

/** Current file state: only `missing` is a deletion, and only `text` can be diffed. */
export type FileState =
  | { kind: "missing" }
  /** The file is there but could not be read: a lock or a permission problem, not a deletion. */
  | { kind: "unreadable"; stat: DiskStat }
  /** `disk` is absent when the text came from an editor buffer, which has neither stat nor BOM. */
  | { kind: "text"; text: string; disk?: { hadBom: boolean; stat: DiskStat } }
  | { kind: "opaque"; reason: OpaqueKind; stat: DiskStat };

export type TextState = Extract<FileState, { kind: "text" }>;
export type OpaqueState = Extract<FileState, { kind: "opaque" }>;

export type StatResult =
  | { kind: "stat"; stat: DiskStat; isDirectory: boolean }
  | { kind: "missing" }
  | { kind: "unreadable" };

/** Only FileNotFound proves deletion; treating access errors as missing risks a destructive revert. */
function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

/** Reads the current state of a file, with no knowledge of what is pending or baselined. */
export class FileStateReader {
  constructor(
    private readonly store: BaselineStore,
    private readonly filter: WorkspaceFilter,
  ) {}

  async stat(uri: vscode.Uri): Promise<StatResult> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return {
        kind: "stat",
        stat: { size: stat.size, mtimeMs: stat.mtime },
        // A bitmask, because a symlinked directory is both.
        isDirectory: (stat.type & vscode.FileType.Directory) !== 0,
      };
    } catch (error) {
      return isFileNotFound(error) ? { kind: "missing" } : { kind: "unreadable" };
    }
  }

  /** An unreadable stat carries no size, so borrow the last one recorded for the file. */
  private lastKnownStat(uri: vscode.Uri): DiskStat {
    const known = this.store.entry(normalizeKey(uri.fsPath));
    const recorded = known?.kind === "opaque" ? known.stat : known?.clean;
    return recorded ?? { size: 0, mtimeMs: 0 };
  }

  /** `fromDiskOnly` skips the editor buffer, which is what the baseline snapshot wants. */
  async read(uri: vscode.Uri, fromDiskOnly = false): Promise<FileState> {
    const doc = fromDiskOnly ? undefined : openDocument(uri);
    const buffer = doc ? documentText(doc) : undefined;
    // Stat even with a buffer because the disk form may also exceed the storage limit.
    const stated = await this.stat(uri);

    if (stated.kind === "missing") {
      // An unsaved new buffer is the only content even though no disk file exists.
      return buffer === undefined || this.filter.exceedsMaxSize(buffer)
        ? { kind: "missing" }
        : { kind: "text", text: buffer };
    }

    if (stated.kind === "unreadable") {
      return { kind: "unreadable", stat: this.lastKnownStat(uri) };
    }

    const stat = stated.stat;

    // Either form may become the next baseline, so both must satisfy the size limit.
    if (
      stat.size > this.filter.maxFileSizeBytes ||
      (buffer !== undefined && this.filter.exceedsMaxSize(buffer))
    ) {
      return { kind: "opaque", reason: "tooLarge", stat };
    }

    if (buffer !== undefined) {
      return { kind: "text", text: buffer };
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const decoded = looksBinary(bytes) ? null : decodeUtf8(bytes);
      if (decoded === null) {
        return { kind: "opaque", reason: "binary", stat };
      }
      return {
        kind: "text",
        text: stripBom(decoded),
        disk: { hadBom: decoded.startsWith(BOM), stat },
      };
    } catch (error) {
      // Stat succeeded earlier; only a later FileNotFound proves the file then disappeared.
      return isFileNotFound(error) ? { kind: "missing" } : { kind: "unreadable", stat };
    }
  }
}
