import * as fs from "node:fs/promises";
import { isErrno } from "../core/files";

/** Grace period for files created by writes that overlap a sweep. */
export const GC_MIN_AGE_MS = 60_000;

/**
 * Aggregates per-entry failures so one unreadable directory does not abort the pass and the
 * caller can report one error.
 */
export interface CollectReport {
  failed: number;
  error: unknown;
}

export function newReport(): CollectReport {
  return { failed: 0, error: undefined };
}

export function note(report: CollectReport, error: unknown): void {
  report.failed += 1;
  report.error ??= error;
}

/** A missing directory has nothing to sweep and is not an error. */
export async function readdirOrEmpty(dir: string, report: CollectReport): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      note(report, error);
    }

    return [];
  }
}

export async function removeIfOlderThan(
  target: string,
  cutoff: number,
  report: CollectReport,
): Promise<boolean> {
  try {
    if ((await fs.stat(target)).mtimeMs >= cutoff) {
      return false;
    }

    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    // Another remover reaching the entry first already achieved the desired result.
    if (!isErrno(error, "ENOENT")) {
      note(report, error);
    }
    return false;
  }
}
