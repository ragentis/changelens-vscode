import * as fs from "node:fs/promises";

let tempCounter = 0;

/** The counter keeps two concurrent writes of the same target from sharing a temp file. */
function nextTempPath(target: string): string {
  tempCounter += 1;
  return `${target}.${process.pid}.${tempCounter}.tmp`;
}

/**
 * Writes through a temp file, so a failed write leaves the previous content in place rather than
 * a truncated file. A write that succeeded but failed to rename would otherwise leave its temp
 * file behind for good, and nothing else ever looks in these directories.
 */
export async function writeFileAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = nextTempPath(target);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
