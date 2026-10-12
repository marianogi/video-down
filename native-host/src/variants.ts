/**
 * Turn yt-dlp's `-J` output into the short list of resolutions shown in the
 * overlay, and build the format selector used later for each one.
 *
 * Pure functions: no Deno APIs, so they are unit-tested with fixtures.
 */

import type { Variant } from "./protocol.ts";

/** The subset of a yt-dlp format we rely on. */
export interface YtdlpFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  has_drm?: boolean | string | null;
  format_note?: string | null;
}

/** The subset of yt-dlp's info dict we rely on. */
export interface YtdlpInfo {
  id?: string;
  title?: string;
  extractor_key?: string;
  extractor?: string;
  is_live?: boolean | null;
  live_status?: string | null;
  duration?: number | null;
  formats?: YtdlpFormat[];
  // Single-format results (direct files) carry the format fields at top level.
  height?: number | null;
  width?: number | null;
  vcodec?: string | null;
  _type?: string;
}

/** A variant as stored on disk by the host: the public part plus its selector. */
export interface StoredVariant extends Variant {
  selector: string;
}

export interface BuiltVariants {
  title: string;
  extractor: string;
  isLive: boolean;
  duration?: number;
  drm: boolean;
  variants: StoredVariant[];
}

const MIN_HEIGHT = 144;

/** Codec preference: compatibility first (QuickTime on macOS plays H.264, not VP9). */
const CODEC_ORDER: Array<{ prefix: string[]; label: string }> = [
  { prefix: ["avc1", "avc3", "h264"], label: "H.264" },
  { prefix: ["hev1", "hvc1", "h265"], label: "HEVC" },
  { prefix: ["vp09", "vp9"], label: "VP9" },
  { prefix: ["av01"], label: "AV1" },
];

function hasVideo(f: YtdlpFormat): boolean {
  return !!f.vcodec && f.vcodec !== "none";
}

function hasAudio(f: YtdlpFormat): boolean {
  return !!f.acodec && f.acodec !== "none";
}

function isDrm(f: YtdlpFormat): boolean {
  return f.has_drm === true || f.has_drm === "maybe";
}

function codecRank(vcodec: string | null | undefined): number {
  const v = (vcodec || "").toLowerCase();
  const i = CODEC_ORDER.findIndex((c) => c.prefix.some((p) => v.startsWith(p)));
  return i === -1 ? CODEC_ORDER.length : i;
}

export function codecLabel(vcodec: string | null | undefined): string | undefined {
  const v = (vcodec || "").toLowerCase();
  const found = CODEC_ORDER.find((c) => c.prefix.some((p) => v.startsWith(p)));
  return found?.label;
}

function sizeOf(f: YtdlpFormat | undefined, duration?: number): number | undefined {
  if (!f) return undefined;
  const direct = f.filesize ?? f.filesize_approx;
  if (direct && direct > 0) return direct;
  if (f.tbr && duration) return Math.round((f.tbr * 1000 * duration) / 8);
  return undefined;
}

/** Best audio-only format, preferring AAC (mp4a) so the MP4 merge never re-encodes. */
function bestAudio(formats: YtdlpFormat[]): YtdlpFormat | undefined {
  const audio = formats.filter((f) => hasAudio(f) && !hasVideo(f) && !isDrm(f));
  audio.sort((a, b) => {
    const aac = Number((b.acodec || "").startsWith("mp4a")) - Number((a.acodec || "").startsWith("mp4a"));
    if (aac !== 0) return aac;
    return (b.tbr ?? 0) - (a.tbr ?? 0);
  });
  return audio[0];
}

/**
 * yt-dlp format selector for a given height. Prefers video-only + AAC audio
 * (DASH-style sites such as YouTube), then a combined format of that height,
 * then the closest lower height, then anything. Never fails outright.
 */
export function selectorForHeight(height: number): string {
  const h = Math.trunc(height);
  const a = "ba[acodec^=mp4a]";
  return [
    `bv[height=${h}][vcodec^=avc1]+${a}`,
    `bv[height=${h}][vcodec^=vp09]+${a}`,
    `bv[height=${h}][vcodec^=vp9]+${a}`,
    `bv[height=${h}]+${a}`,
    `bv[height=${h}]+ba`,
    `b[height=${h}]`,
    `bv[height<=${h}]+ba`,
    `b[height<=${h}]`,
    "b",
  ].join("/");
}

export const BEST_SELECTOR = "bv[vcodec^=avc1]+ba[acodec^=mp4a]/bv+ba/b";

export function buildVariants(info: YtdlpInfo): BuiltVariants {
  const formats = info.formats && info.formats.length > 0 ? info.formats : [info as YtdlpFormat];
  const duration = info.duration ?? undefined;
  const isLive = info.is_live === true || info.live_status === "is_live" || info.live_status === "is_upcoming";

  const video = formats.filter(hasVideo);
  const clearVideo = video.filter((f) => !isDrm(f));
  const drm = video.length > 0 && clearVideo.length === 0;

  const base = {
    title: info.title || info.id || "video",
    extractor: info.extractor_key || info.extractor || "generic",
    isLive,
    ...(duration ? { duration } : {}),
    drm,
  };

  if (drm || isLive) {
    return { ...base, variants: [] };
  }

  const audio = bestAudio(formats);
  const byHeight = new Map<number, YtdlpFormat>();
  for (const f of clearVideo) {
    const h = f.height ?? 0;
    if (h < MIN_HEIGHT) continue;
    const current = byHeight.get(h);
    if (!current) {
      byHeight.set(h, f);
      continue;
    }
    const rank = codecRank(f.vcodec) - codecRank(current.vcodec);
    if (rank < 0 || (rank === 0 && (f.tbr ?? 0) > (current.tbr ?? 0))) {
      byHeight.set(h, f);
    }
  }

  const variants: StoredVariant[] = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([h, f]) => {
      const fps = f.fps && f.fps >= 48 ? Math.round(f.fps) : undefined;
      const videoSize = sizeOf(f, duration);
      const audioSize = hasAudio(f) ? 0 : sizeOf(audio, duration);
      const approxBytes =
        videoSize !== undefined ? videoSize + (audioSize ?? 0) : undefined;
      const v: StoredVariant = {
        id: `h${h}`,
        label: fps ? `${h}p${fps}` : `${h}p`,
        height: h,
        selector: selectorForHeight(h),
      };
      if (f.width) v.width = f.width;
      if (fps) v.fps = fps;
      const codec = codecLabel(f.vcodec);
      if (codec) v.vcodec = codec;
      if (approxBytes) v.approxBytes = approxBytes;
      return v;
    });

  if (variants.length === 0) {
    // Direct files and sites that expose no resolution metadata.
    variants.push({ id: "best", label: "best", selector: BEST_SELECTOR });
  }

  return { ...base, variants };
}

/** Strip the server-only selector before sending variants to the extension. */
export function publicVariants(stored: StoredVariant[]): Variant[] {
  return stored.map(({ selector: _selector, ...rest }) => rest);
}
