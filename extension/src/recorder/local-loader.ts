/**
 * hls.js loader that serves a recording from IndexedDB: the playlists are built from the
 * stored parts on every request (they grow while recording), and parts and init segments are
 * read from their stored blobs. It never touches the network: any URL that is not one of the
 * recording's local URLs is refused.
 */

import { LoadStats, type HlsConfig, type Loader, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from "hls.js";
import { masterPlaylist, mediaPlaylist, parseLocalUrl, type PartRef, type TrackKind } from "../core/recording/local-playlist";
import { getInit, getPart, listPartsFrom, type RecordingInfo } from "../core/recording/store";

/** What the page knows about the recording, kept current from the worker's progress messages. */
export interface LocalSource {
  info(): RecordingInfo | null;
}

/** Part lists, read incrementally: each playlist reload only asks IndexedDB for what is new. */
const cache = new Map<string, PartRef[]>();

async function partsOf(recordingId: string, track: TrackKind): Promise<PartRef[]> {
  const key = `${recordingId}/${track}`;
  const known = cache.get(key) ?? [];
  const fresh = await listPartsFrom(recordingId, track, known.length);
  for (const p of fresh) {
    known.push({
      seq: p.seq,
      duration: p.duration,
      ...(p.discontinuity ? { discontinuity: true } : {}),
      ...(p.initId !== undefined ? { initId: p.initId } : {}),
    });
  }
  cache.set(key, known);
  return known;
}

export function makeLocalLoader(source: LocalSource): new (config: HlsConfig) => Loader<LoaderContext> {
  return class LocalLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats = new LoadStats();
    private aborted = false;

    constructor(_config: HlsConfig) {}

    destroy(): void {
      this.aborted = true;
      this.context = null;
    }

    abort(): void {
      this.aborted = true;
      this.stats.aborted = true;
    }

    load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context;
      this.aborted = false;
      const stats = this.stats;
      stats.loading.start = performance.now();
      void this.read(context)
        .then((data) => {
          if (this.aborted) return;
          const size = typeof data === "string" ? data.length : data.byteLength;
          stats.loading.first = stats.loading.end = performance.now();
          stats.loaded = stats.total = size;
          callbacks.onSuccess({ url: context.url, data }, stats, context, null);
        })
        .catch((err: unknown) => {
          if (this.aborted) return;
          stats.loading.end = performance.now();
          callbacks.onError({ code: 404, text: err instanceof Error ? err.message : String(err) }, context, null, stats);
        });
    }

    private async read(context: LoaderContext): Promise<string | ArrayBuffer> {
      const req = parseLocalUrl(context.url);
      const info = source.info();
      if (!req || !info || req.recordingId !== info.id) throw new Error("not part of this recording");
      if (req.kind === "playlist") {
        if (req.name === "master") return masterPlaylist(info.id, info.tracks.includes("audio"), info.codecs);
        const complete = info.state !== "recording";
        return mediaPlaylist(info.id, req.name, await partsOf(info.id, req.name), complete);
      }
      const blob =
        req.kind === "part"
          ? (await getPart(req.recordingId, req.track, req.seq))?.blob
          : await getInit(req.recordingId, req.track, req.initId);
      if (!blob) throw new Error("missing part");
      let data = await blob.arrayBuffer();
      if (context.rangeEnd) data = data.slice(context.rangeStart ?? 0, context.rangeEnd);
      return data;
    }
  };
}
