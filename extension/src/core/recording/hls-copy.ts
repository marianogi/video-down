/**
 * Exact copy of a live HLS stream: the original segments, as the CDN serves them, stored as
 * they appear. No re-encoding: the quality of the broadcast and almost no CPU.
 *
 * Runs in the service worker: unlike a background tab, its timers are not slowed down to once a
 * minute, which would lose segments of a live playlist. Fetches with the user's cookies and, through temporary
 * declarativeNetRequest rules, with the player page's Origin and Referer, like the downloads.
 * AES-128 segments (key published in the playlist, not DRM) are decrypted before storing, so
 * the recording plays and saves like any other. Any other encryption stops the recording.
 */

import { addHeaderRulesForUrls, coverRedirect, removeHeaderRules } from "../downloader/header-rules";
import { hasUnsupportedKey, liveUpdate, reloadDelayMs, type LiveSegment } from "./hls-live";
import type { TrackKind } from "./local-playlist";
import { putInit, putPart, type StoredPart } from "./store";

export interface CopyTrack {
  track: TrackKind;
  playlistUrl: string;
}

export interface CopyCallbacks {
  onPart(part: StoredPart): void;
  /** Segments that left the live playlist before they could be fetched */
  onLost(track: TrackKind, count: number): void;
  /** The broadcast is over (#EXT-X-ENDLIST) */
  onEnded(): void;
  onError(message: string): void;
}

const PLAYLIST_ATTEMPTS = 6;
const SEGMENT_ATTEMPTS = 3;

class Stopped extends Error {}

export class HlsCopyRecorder {
  private stopped = false;
  /** One per track loop that is waiting for its next playlist reload */
  private wakers = new Set<() => void>();
  private ruleIds: number[] = [];
  private coveredHosts = new Set<string>();
  private keys = new Map<string, CryptoKey>();

  constructor(
    private readonly recordingId: string,
    private readonly tracks: CopyTrack[],
    private readonly pageUrl: string,
    private readonly cb: CopyCallbacks,
  ) {}

  async start(): Promise<void> {
    const results = await Promise.allSettled(this.tracks.map((t) => this.follow(t)));
    await removeHeaderRules(this.ruleIds).catch(() => undefined);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected" && !(r.reason instanceof Stopped));
    if (failure && !this.stopped) {
      this.stopped = true;
      this.cb.onError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const wake of [...this.wakers]) wake();
  }

  private async follow({ track, playlistUrl }: CopyTrack): Promise<void> {
    let lastSeq: number | null = null;
    let seqOut = 0;
    const initIds = new Map<string, number>();
    let pendingGap = false;

    while (!this.stopped) {
      const { text, url } = await this.withRetries(PLAYLIST_ATTEMPTS, () => this.fetchText(playlistUrl));
      if (hasUnsupportedKey(text)) throw new Error("drm");
      const update = liveUpdate(text, url, lastSeq);
      if (update.lost > 0) this.cb.onLost(track, update.lost);

      for (const seg of update.segments) {
        if (this.stopped) return;
        let data: ArrayBuffer;
        try {
          data = await this.withRetries(SEGMENT_ATTEMPTS, () => this.segmentData(seg));
        } catch (err) {
          if (err instanceof Stopped) return;
          // One segment the CDN will not give: leave a marked gap rather than stop the recording.
          this.cb.onLost(track, 1);
          pendingGap = true;
          lastSeq = seg.seq;
          continue;
        }
        let initId: number | undefined;
        if (seg.map) {
          const mapKey = `${seg.map.uri}|${seg.map.byteRange?.offset ?? ""}|${seg.map.byteRange?.length ?? ""}`;
          initId = initIds.get(mapKey);
          if (initId === undefined) {
            const map = seg.map;
            const init = await this.withRetries(SEGMENT_ATTEMPTS, () => this.fetchBytes(map.uri, map.byteRange));
            initId = initIds.size;
            initIds.set(mapKey, initId);
            await putInit(this.recordingId, track, initId, new Blob([init]));
          }
        }
        const part: StoredPart = {
          recordingId: this.recordingId,
          track,
          seq: seqOut++,
          duration: seg.duration,
          ...(seg.discontinuity || pendingGap ? { discontinuity: true } : {}),
          ...(initId !== undefined ? { initId } : {}),
          size: data.byteLength,
          blob: new Blob([data]),
        };
        pendingGap = false;
        await putPart(part);
        lastSeq = seg.seq;
        this.cb.onPart(part);
      }

      if (update.ended) {
        this.cb.onEnded();
        return;
      }
      await this.sleep(reloadDelayMs(update));
    }
  }

  // ---------------------------------------------------------------- network

  private async cover(urls: string[]): Promise<void> {
    const fresh = urls.filter((u) => {
      try {
        const host = new URL(u).host;
        if (this.coveredHosts.has(host)) return false;
        this.coveredHosts.add(host);
        return true;
      } catch {
        return false;
      }
    });
    if (fresh.length === 0 || !/^https?:/i.test(this.pageUrl)) return;
    const ids = await addHeaderRulesForUrls(`rec_${this.recordingId}`, fresh, this.pageUrl).catch(() => []);
    this.ruleIds.push(...ids);
  }

  /**
   * A request whose server redirected it to another one that refused it (it wanted the page's
   * headers, which do not follow a redirect to a host no rule covers): cover that host, ask again.
   */
  private async fetchCovered(url: string, init: RequestInit): Promise<Response> {
    await this.cover([url]);
    const res = await fetch(url, init);
    if (res.ok || !res.redirected || !(await coverRedirect(url, res.url).catch(() => false))) return res;
    return fetch(url, init);
  }

  private async fetchText(url: string): Promise<{ text: string; url: string }> {
    const res = await this.fetchCovered(url, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), url: res.url || url };
  }

  private async fetchBytes(url: string, range?: { offset: number; length: number }): Promise<ArrayBuffer> {
    const headers: Record<string, string> = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
    const res = await this.fetchCovered(url, { credentials: "include", headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // A server that ignores Range sends the whole file: keep only the requested bytes.
    if (range && res.status === 200 && buf.byteLength > range.length) return buf.slice(range.offset, range.offset + range.length);
    return buf;
  }

  private async segmentData(seg: LiveSegment): Promise<ArrayBuffer> {
    const data = await this.fetchBytes(seg.uri, seg.byteRange);
    if (!seg.key) return data;
    const key = await this.key(seg.key.uri);
    const iv = new Uint8Array(seg.key.iv.match(/../g)!.map((h) => parseInt(h, 16)));
    return crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, data);
  }

  private async key(uri: string): Promise<CryptoKey> {
    const cached = this.keys.get(uri);
    if (cached) return cached;
    const raw = await this.withRetries(SEGMENT_ATTEMPTS, () => this.fetchBytes(uri));
    if (raw.byteLength !== 16) throw new Error("AES-128 key is not 16 bytes");
    const key = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
    this.keys.set(uri, key);
    return key;
  }

  private async withRetries<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      if (this.stopped) throw new Stopped();
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (i < attempts - 1) await this.sleep(Math.min(8000, 500 * 2 ** i));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakers.add(wake);
    });
  }
}
