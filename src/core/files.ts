import * as fs from "node:fs/promises";

/** File stat fields used as a cheap unchanged-content hint. */
export interface DiskStat {
  size: number;
  mtimeMs: number;
}

/** Why a file has no usable text: its bytes are not text, or it is past the size limit. */
export type OpaqueKind = "binary" | "tooLarge";

const TEMP_SUFFIX = ".tmp";

let tempCounter = 0;

/** The PID separates processes; the counter separates concurrent writes within one process. */
function nextTempPath(target: string): string {
  tempCounter += 1;
  return `${target}.${process.pid}.${tempCounter}${TEMP_SUFFIX}`;
}

/**
 * Recognizes the temp-file pattern used by {@link writeFileAtomic}. Both arguments are basenames;
 * callers scope cleanup to the target directory and apply an age cutoff.
 */
export function isTempFileFor(name: string, target: string): boolean {
  return name.startsWith(`${target}.`) && name.endsWith(TEMP_SUFFIX);
}

/**
 * Writes through a unique sibling temp file so failure cannot truncate the existing target.
 * Cleanup is best effort and never replaces the original write error; leftovers are swept later.
 */
export async function writeFileAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = nextTempPath(target);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
