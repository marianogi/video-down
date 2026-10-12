/**
 * Build the list of resolutions shown in the overlay for media the browser can
 * download by itself (HLS and DASH manifests). Pure: unit-tested with fixtures.
 */

import { parseMasterPlaylist, isMasterPlaylist } from "./parsers/m3u8-parser";
import { parseManifest } from "./parsers/mpd-parser";
import { VideoFormat } from "./types";

export interface ManifestQuality {
  videoPlaylistUrl?: string | null;
  audioPlaylistUrl?: string | null;
  selectedBandwidth?: number;
}

export interface BrowserVariant {
  /** Stable key inside one manifest, e.g. "h1080-5000000". */
  id: string;
  /** "1080p", "720p"… or a bitrate when the manifest has no resolution. */
  label: string;
  height?: number;
  width?: number;
  /** Bits per second (video + audio when the manifest says so). */
  bandwidth?: number;
  codecs?: string;
  approxBytes?: number;
  /** Passed back unchanged to the download request. Undefined = whole playlist. */
  manifestQuality?: ManifestQuality;
}

function bitrateLabel(bps: number): string {
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

function estimate(bandwidth: number | undefined, duration: number | undefined): number | undefined {
  if (!bandwidth || !duration || !Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.round((bandwidth * duration) / 8);
}

/** Keep the highest-bitrate entry per height, sorted from best to worst. */
function dedupeByHeight<T extends { height?: number; bandwidth?: number }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const key = item.height ? `h${item.height}` : `b${item.bandwidth ?? 0}`;
    const current = best.get(key);
    if (!current || (item.bandwidth ?? 0) > (current.bandwidth ?? 0)) best.set(key, item);
  }
  return [...best.values()].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
  );
}

/**
 * HLS: one entry per video rendition of a master playlist, paired with the
 * first audio rendition when audio is delivered separately.
 * A plain media playlist yields a single "original" entry.
 */
export function hlsVariants(playlistText: string, playlistUrl: string, duration?: number): BrowserVariant[] {
  if (!isMasterPlaylist(playlistText)) {
    return [{ id: "original", label: "original" }];
  }
  const levels = parseMasterPlaylist(playlistText, playlistUrl);
  const audio = levels.find((l) => l.type === "audio");
  const seenUris = new Set<string>();
  const video = levels.filter((l) => {
    if (l.type !== "stream" || seenUris.has(l.uri)) return false;
    seenUris.add(l.uri);
    return true;
  });

  const candidates = video.map((l) => ({
    height: l.height,
    width: l.width,
    bandwidth: l.bitrate,
    uri: l.uri,
  }));

  return dedupeByHeight(candidates).map((c) => {
    const v: BrowserVariant = {
      id: `h${c.height ?? 0}-${c.bandwidth ?? 0}`,
      label: c.height ? `${c.height}p` : c.bandwidth ? bitrateLabel(c.bandwidth) : "original",
      manifestQuality: { videoPlaylistUrl: c.uri, audioPlaylistUrl: audio?.uri ?? null },
    };
    if (c.height) v.height = c.height;
    if (c.width) v.width = c.width;
    if (c.bandwidth) v.bandwidth = c.bandwidth;
    const bytes = estimate(c.bandwidth, duration);
    if (bytes) v.approxBytes = bytes;
    return v;
  });
}

/**
 * DASH: one entry per video Representation. The download handler adds the
 * first audio AdaptationSet automatically.
 */
export function dashVariants(mpdText: string, mpdUrl: string, duration?: number): BrowserVariant[] {
  const manifest = parseManifest(mpdText, mpdUrl);
  const mpdDuration = typeof manifest.duration === "number" ? (manifest.duration as number) : undefined;
  const total = duration && Number.isFinite(duration) ? duration : mpdDuration;

  let audioBandwidth = 0;
  const audioGroup = manifest.mediaGroups?.AUDIO?.audio;
  if (audioGroup) {
    for (const group of Object.values(audioGroup)) {
      const bw = group.playlists?.[0]?.attributes?.BANDWIDTH;
      if (bw) {
        audioBandwidth = bw;
        break;
      }
    }
  }

  const candidates = (manifest.playlists || []).map((p) => ({
    height: p.attributes?.RESOLUTION?.height,
    width: p.attributes?.RESOLUTION?.width,
    bandwidth: p.attributes?.BANDWIDTH,
    codecs: p.attributes?.CODECS,
  }));

  return dedupeByHeight(candidates).map((c) => {
    const v: BrowserVariant = {
      id: `h${c.height ?? 0}-${c.bandwidth ?? 0}`,
      label: c.height ? `${c.height}p` : c.bandwidth ? bitrateLabel(c.bandwidth) : "original",
      manifestQuality: c.bandwidth ? { selectedBandwidth: c.bandwidth } : undefined,
    };
    if (c.height) v.height = c.height;
    if (c.width) v.width = c.width;
    if (c.bandwidth) v.bandwidth = c.bandwidth;
    if (c.codecs) v.codecs = c.codecs;
    const bytes = estimate((c.bandwidth ?? 0) + audioBandwidth || undefined, total);
    if (bytes) v.approxBytes = bytes;
    return v;
  });
}

export function variantsFor(
  format: VideoFormat,
  text: string,
  url: string,
  duration?: number,
): BrowserVariant[] {
  switch (format) {
    case VideoFormat.HLS:
    case VideoFormat.M3U8:
      return hlsVariants(text, url, duration);
    case VideoFormat.DASH:
      return dashVariants(text, url, duration);
    default:
      return [{ id: "original", label: "original" }];
  }
}
