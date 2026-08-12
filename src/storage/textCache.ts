/** Byte-bounded least-recently-used text cache, keyed by blob hash. */
export class TextCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly budget: number) {}

  /** Approximated from UTF-16 code units, which is close enough to bound a cache. */
  private static sizeOf(text: string): number {
    return text.length * 2;
  }

  private drop(hash: string): void {
    const text = this.entries.get(hash);
    if (text !== undefined) {
      this.bytes -= TextCache.sizeOf(text);
      this.entries.delete(hash);
    }
  }

  get(hash: string): string | undefined {
    const text = this.entries.get(hash);
    if (text === undefined) {
      return undefined;
    }
    this.entries.delete(hash);
    this.entries.set(hash, text);
    return text;
  }

  put(hash: string, text: string): void {
    this.drop(hash);
    this.entries.set(hash, text);
    this.bytes += TextCache.sizeOf(text);
    // Keep the newest entry even when it exceeds the budget; otherwise large content could never
    // benefit from the cache.
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.budget || oldest === hash) {
        return;
      }
      this.drop(oldest);
    }
  }
}
