import * as crypto from "node:crypto";

export const BOM = "\uFEFF";

/**
 * Identifies text without retaining it. The model compares the last disk reading of every tracked
 * file against the next one, and holding the whole workspace's content to do it would cost more
 * memory than the baselines themselves. Truncated like the blob hash, for the same reason.
 */
export function textDigest(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function detectEol(text: string): "\n" | "\r\n" | "\r" {
  const match = /\r\n|\n|\r/.exec(text)?.[0];
  return match === "\r\n" || match === "\r" ? match : "\n";
}

/**
 * Splits into lines without keeping terminators. A trailing newline yields a final empty
 * entry, which is what makes "file ends with newline" a diffable property.
 */
export function splitLines(text: string): string[] {
  return stripBom(text).split(/\r\n|\n|\r/);
}

export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

/** `ignoreBOM` keeps a leading U+FEFF in the string, so the stored baseline round-trips. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Returns null for bytes that are not valid UTF-8. A lossy decode would put replacement
 * characters into the baseline, and reverting would then write them over the user's file.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}
