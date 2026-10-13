/**
 * Playlists exactly as the page's player received them (reported by content/main-world.ts and
 * accepted only for URLs the page really requested), plus masters found next to a variant.
 *
 * Reading a playlist again is not always possible: single-use links, tokens that expire in
 * seconds, or a CDN that only answers the player. With the page's own copy the qualities can be
 * listed anyway. Bounded in entries and characters so a long session cannot grow it forever.
 */

export class PlaylistBodies {
  private readonly items = new Map<string, { text: string; at: number }>();
  private chars = 0;

  constructor(
    private readonly maxEntries = 40,
    private readonly maxChars = 8_000_000,
  ) {}

  private static key(url: string): string {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.href;
    } catch {
      return url;
    }
  }

  set(url: string, text: string, at = Date.now()): void {
    if (text.length > this.maxChars) return;
    const key = PlaylistBodies.key(url);
    this.delete(key);
    this.items.set(key, { text, at });
    this.chars += text.length;
    while (this.items.size > this.maxEntries || this.chars > this.maxChars) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  /**
   * Only the exact address (fragment aside). Some sites choose the video with a query
   * parameter on the same path, so another query string may be another video.
   */
  get(url: string): string | undefined {
    return this.items.get(PlaylistBodies.key(url))?.text;
  }

  /** Forget copies older than a moment (the page moved on to another video). */
  dropBefore(at: number): void {
    for (const [key, item] of [...this.items]) if (item.at < at) this.delete(key);
  }

  get size(): number {
    return this.items.size;
  }

  private delete(key: string): void {
    const item = this.items.get(key);
    if (!item) return;
    this.chars -= item.text.length;
    this.items.delete(key);
  }
}
