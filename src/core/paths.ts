import * as path from "node:path";

/**
 * Canonical identity for a tracked file. VS Code hands out the same path with different
 * spellings depending on the API (drive-letter case in particular), and two spellings would
 * otherwise become two entries for one file.
 *
 * Case folding is deliberately limited to Windows, where the filesystem is always
 * case-insensitive. Linux is case-sensitive, and macOS depends on how the volume was
 * formatted; folding there would merge two genuinely distinct files into one baseline, which
 * is a far worse failure than the duplicate entry it would prevent.
 */
export function normalizeKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True when `child` resolves inside `root` rather than escaping through `..`. */
export function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

let tempCounter = 0;

/** The counter keeps two concurrent writes of the same target from sharing a temp file. */
export function tempPath(target: string): string {
  tempCounter += 1;
  return `${target}.${process.pid}.${tempCounter}.tmp`;
}
