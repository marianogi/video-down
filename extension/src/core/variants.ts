/**
 * Build the list of resolutions shown in the overlay for media the browser can
 * download by itself (HLS and DASH manifests). Pure: unit-tested with fixtures.
 */

import { parseMasterPlaylist, isMasterPlaylist, audioFor } from "./parsers/m3u8-parser";
import { parseManifest } from "./parsers/mpd-parser";
import { VideoFormat } from "./types";

export interface ManifestQuality {
  videoPlaylistUrl?: string | null;
  audioPlaylistUrl?: string | null;
  selectedBandwidth?: number;
  /** Only the sound. HLS: only audioPlaylistUrl is downloaded. DASH: this group and bandwidth. */
  audioOnly?: boolean;
  audioGroup?: string;
  selectedAudioBandwidth?: number;
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
  /** "H.264", "HEVC"… when the manifest says */
  codecLabel?: string;
  /** Sound only: `label` then says its language or codec and its bitrate */
  audioOnly?: boolean;
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

const VIDEO_CODECS: Array<[RegExp, string]> = [
  [/\bavc[13]/i, "H.264"],
  [/\b(?:hvc1|hev1)/i, "HEVC"],
  [/\bdv[ah]/i, "Dolby Vision"],
  [/\bvp0?9/i, "VP9"],
  [/\bav01/i, "AV1"],
];
const AUDIO_CODECS: Array<[RegExp, string]> = [
  [/\bmp4a/i, "AAC"],
  [/\bopus/i, "Opus"],
  [/\b(?:ac-3|ac3)/i, "AC-3"],
  [/\b(?:ec-3|eac3)/i, "E-AC-3"],
  [/\bflac/i, "FLAC"],
];

function codecLabel(table: Array<[RegExp, string]>, codecs: string | undefined): string | undefined {
  return codecs ? table.find(([re]) => re.test(codecs))?.[1] : undefined;
}

/** A variant whose CODECS name only sound. Without CODECS nothing can be said: it stays a video. */
function isSoundOnly(codecs: string | undefined): boolean {
  return !!codecs && !codecLabel(VIDEO_CODECS, codecs) && !!codecLabel(AUDIO_CODECS, codecs);
}

/** The bitrate an audio group's id usually carries: "audio-128000", "audio-aacl-96". */
function bitrateFromGroup(group: string | undefined): number | undefined {
  const found = group?.match(/(\d{2,7})(?!.*\d)/)?.[1];
  if (!found) return undefined;
  const n = Number(found);
  return n >= 8000 ? n : n >= 8 ? n * 1000 : undefined;
}

/** Keep the highest-bitrate entry per height and codec, sorted from best to worst. */
function dedupeByHeight<T extends { height?: number; bandwidth?: number; codecLabel?: string | undefined }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const key = `${item.height ? `h${item.height}` : `b${item.bandwidth ?? 0}`}|${item.codecLabel ?? ""}`;
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
  const seenUris = new Set<string>();
  const video = levels.filter((l) => {
    if (l.type !== "stream" || seenUris.has(l.uri) || isSoundOnly(l.codecs)) return false;
    seenUris.add(l.uri);
    return true;
  });

  const candidates = video.map((l) => ({
    height: l.height,
    width: l.width,
    bandwidth: l.bitrate,
    uri: l.uri,
    audioUri: audioFor(levels, l)?.uri ?? null,
    codecLabel: codecLabel(VIDEO_CODECS, l.codecs),
  }));

  const videos = dedupeByHeight(candidates).map((c) => {
    const v: BrowserVariant = {
      id: `h${c.height ?? 0}-${c.bandwidth ?? 0}-${c.codecLabel ?? ""}`,
      label: c.height ? `${c.height}p` : c.bandwidth ? bitrateLabel(c.bandwidth) : "original",
      manifestQuality: { videoPlaylistUrl: c.uri, audioPlaylistUrl: c.audioUri },
    };
    if (c.height) v.height = c.height;
    if (c.width) v.width = c.width;
    if (c.bandwidth) v.bandwidth = c.bandwidth;
    if (c.codecLabel) v.codecLabel = c.codecLabel;
    const bytes = estimate(c.bandwidth, duration);
    if (bytes) v.approxBytes = bytes;
    return v;
  });

  // The sound: separate audio renditions, and variants that carry only sound.
  const sounds = new Map<string, { name: string; bandwidth: number | undefined }>();
  for (const l of levels) {
    if (sounds.has(l.uri)) continue;
    if (l.type === "audio") {
      sounds.set(l.uri, { name: l.name || l.language || "Audio", bandwidth: bitrateFromGroup(l.groupId) });
    } else if (isSoundOnly(l.codecs)) {
      sounds.set(l.uri, { name: codecLabel(AUDIO_CODECS, l.codecs) ?? "Audio", bandwidth: l.bitrate });
    }
  }
  const audios = [...sounds.entries()]
    .sort((a, b) => (b[1].bandwidth ?? 0) - (a[1].bandwidth ?? 0))
    .map(([uri, s], i) => {
      const v: BrowserVariant = {
        id: `a${i}`,
        label: s.bandwidth ? `${s.name} ${bitrateLabel(s.bandwidth)}` : s.name,
        audioOnly: true,
        manifestQuality: { videoPlaylistUrl: null, audioPlaylistUrl: uri, audioOnly: true },
      };
      if (s.bandwidth) v.bandwidth = s.bandwidth;
      const bytes = estimate(s.bandwidth, duration);
      if (bytes) v.approxBytes = bytes;
      return v;
    });
  return [...videos, ...audios];
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
    codecLabel: codecLabel(VIDEO_CODECS, p.attributes?.CODECS),
  }));

  const videos = dedupeByHeight(candidates).map((c) => {
    const v: BrowserVariant = {
      id: `h${c.height ?? 0}-${c.bandwidth ?? 0}-${c.codecLabel ?? ""}`,
      label: c.height ? `${c.height}p` : c.bandwidth ? bitrateLabel(c.bandwidth) : "original",
      manifestQuality: c.bandwidth ? { selectedBandwidth: c.bandwidth } : undefined,
    };
    if (c.height) v.height = c.height;
    if (c.width) v.width = c.width;
    if (c.bandwidth) v.bandwidth = c.bandwidth;
    if (c.codecs) v.codecs = c.codecs;
    if (c.codecLabel) v.codecLabel = c.codecLabel;
    const bytes = estimate((c.bandwidth ?? 0) + audioBandwidth || undefined, total);
    if (bytes) v.approxBytes = bytes;
    return v;
  });

  // Each audio track, on its own.
  const audios: BrowserVariant[] = [];
  for (const [group, entry] of Object.entries(audioGroup ?? {})) {
    for (const playlist of entry.playlists ?? []) {
      const bandwidth = playlist.attributes?.BANDWIDTH;
      const language = (entry as { language?: string }).language;
      const name = (language && language !== "und" ? language : "") || codecLabel(AUDIO_CODECS, playlist.attributes?.CODECS) || "Audio";
      const v: BrowserVariant = {
        id: `a${audios.length}`,
        label: bandwidth ? `${name} ${bitrateLabel(bandwidth)}` : name,
        audioOnly: true,
        manifestQuality: { audioOnly: true, audioGroup: group, ...(bandwidth ? { selectedAudioBandwidth: bandwidth } : {}) },
      };
      if (bandwidth) v.bandwidth = bandwidth;
      const bytes = estimate(bandwidth, total);
      if (bytes) v.approxBytes = bytes;
      audios.push(v);
    }
  }
  audios.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  return [...videos, ...audios];
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
