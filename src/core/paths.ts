import * as path from "node:path";

/**
 * Canonical identity for a tracked file. VS Code APIs can spell the same Windows path differently,
 * notably in drive-letter case, which would otherwise create duplicate entries.
 *
 * Case folding is limited to Windows, following its normal case-insensitive path identity. Linux
 * is case-sensitive, while macOS depends on the volume; folding either could merge distinct files
 * into one baseline.
 */
export function normalizeKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Normalized prefix used to match tracked descendants when an event names a directory rather than
 * each file under it.
 */
export function dirPrefix(fsPath: string): string {
  const key = normalizeKey(fsPath);
  return key.endsWith(path.sep) ? key : key + path.sep;
}

/** True only when `child` resolves to a strict descendant of `root`. */
export function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
