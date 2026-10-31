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
  abr?: number | null;
  language?: string | null;
  has_drm?: boolean | string | null;
  format_note?: string | null;
}

/** The subset of yt-dlp's info dict we rely on. */
export interface YtdlpInfo {
  id?: string;
  title?: string;
  channel?: string | null;
  uploader?: string | null;
  creator?: string | null;
  uploader_id?: string | null;
  description?: string | null;
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
  channel?: string;
  description?: string;
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

const AUDIO_CODECS: Array<{ prefix: string[]; label: string }> = [
  { prefix: ["mp4a", "aac"], label: "AAC" },
  { prefix: ["opus"], label: "Opus" },
  { prefix: ["vorbis"], label: "Vorbis" },
  { prefix: ["mp3"], label: "MP3" },
  { prefix: ["flac"], label: "FLAC" },
  { prefix: ["ac-3", "ac3"], label: "AC-3" },
  { prefix: ["ec-3", "eac3"], label: "E-AC-3" },
];

function audioCodecLabel(acodec: string | null | undefined): string | undefined {
  const a = (acodec || "").toLowerCase();
  return AUDIO_CODECS.find((c) => c.prefix.some((p) => a.startsWith(p)))?.label;
}

/** Sound with no image. A stream's codec may be unknown: only "none" says there is no sound. */
function isAudioOnly(f: YtdlpFormat): boolean {
  return f.vcodec === "none" && f.acodec !== "none" && !isDrm(f);
}

/** One entry per kind of sound: codec, file type, language and bitrate. AAC first, the best first. */
function audioVariants(formats: YtdlpFormat[], duration?: number): StoredVariant[] {
  const kinds = new Map<string, YtdlpFormat>();
  const kbpsOf = (f: YtdlpFormat) => Math.round(f.abr ?? f.tbr ?? 0);
  const languageOf = (f: YtdlpFormat) => (/^[A-Za-z-]{2,12}$/.test(f.language ?? "") ? f.language! : "");
  for (const f of formats.filter(isAudioOnly)) {
    // Bitrates this close are the same audio (YouTube's "-drc" copies).
    const key = [audioCodecLabel(f.acodec) ?? f.acodec, f.ext, languageOf(f), Math.round(kbpsOf(f) / 16)].join("|");
    const current = kinds.get(key);
    if (!current || kbpsOf(f) > kbpsOf(current)) kinds.set(key, f);
  }
  const order = (f: YtdlpFormat) => (audioCodecLabel(f.acodec) === "AAC" ? 0 : 1);
  const all = [...kinds.values()];
  // A stream with no codec and no bitrate says nothing next to the ones that do (YouTube's HLS copy).
  const named = all.filter((f) => audioCodecLabel(f.acodec) || kbpsOf(f));
  return (named.length > 0 ? named : all)
    .sort((a, b) => order(a) - order(b) || kbpsOf(b) - kbpsOf(a))
    .map((f, i) => {
      const kbps = kbpsOf(f);
      const language = languageOf(f);
      const name = audioCodecLabel(f.acodec) ?? "Audio";
      const exact = /^[\w.-]+$/.test(f.format_id ?? "") ? `${f.format_id}/` : "";
      const v: StoredVariant = {
        id: `a${i}`,
        label: [name, kbps ? `${kbps} kbps` : "", language].filter(Boolean).join(" "),
        audioOnly: true,
        ext: expectedExt([f], undefined),
        // The exact format, or the closest if the site renamed it by the time of the download.
        selector: `${exact}${language ? `ba[language=${language}]/` : ""}ba`,
      };
      const size = sizeOf(f, duration);
      if (size) v.approxBytes = size;
      return v;
    });
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

/**
 * The same height in a codec other than the preferred one (and at its frame rate, when known),
 * then whatever selectorForHeight finds if the site no longer offers it.
 */
function selectorForCodec(height: number, prefixes: string[], fps: number | undefined): string {
  const h = Math.trunc(height);
  const rate = fps ? `[fps>=48]` : "";
  const a = "ba[acodec^=mp4a]";
  const exact = prefixes.flatMap((p) => [
    `bv[height=${h}][vcodec^=${p}]${rate}+${a}`,
    `bv[height=${h}][vcodec^=${p}]${rate}+ba`,
    `b[height=${h}][vcodec^=${p}]${rate}`,
  ]);
  return [...exact, selectorForHeight(h)].join("/");
}

export const BEST_SELECTOR = "bv[vcodec^=avc1]+ba[acodec^=mp4a]/bv+ba/b";

/**
 * The extension a selector should end up with: separate video and audio are merged into MP4
 * (--merge-output-format); a single format keeps its own, and yt-dlp lists the best one last.
 * Only used to propose a name: the file on disk always gets the extension yt-dlp gives it.
 */
function expectedExt(candidates: YtdlpFormat[], audio: YtdlpFormat | undefined): string {
  if (audio && candidates.some((f) => f.acodec === "none")) return "mp4";
  const ext = candidates.at(-1)?.ext ?? "";
  return /^[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : "mp4";
}

/** Who published it. A bare number (Instagram's uploader_id) says nothing in a file name. */
function channelOf(info: YtdlpInfo): string | undefined {
  const id = info.uploader_id && !/^\d+$/.test(info.uploader_id) ? info.uploader_id : undefined;
  return (info.channel || info.uploader || info.creator || id)?.trim().slice(0, 100) || undefined;
}

export function buildVariants(info: YtdlpInfo): BuiltVariants {
  const formats = info.formats && info.formats.length > 0 ? info.formats : [info as YtdlpFormat];
  const duration = info.duration ?? undefined;
  const isLive = info.is_live === true || info.live_status === "is_live" || info.live_status === "is_upcoming";

  const video = formats.filter(hasVideo);
  const clearVideo = video.filter((f) => !isDrm(f));
  const drm = video.length > 0 && clearVideo.length === 0;

  const channel = channelOf(info);
  const description = info.description?.trim().slice(0, 400);
  const base = {
    title: info.title || info.id || "video",
    ...(channel ? { channel } : {}),
    ...(description ? { description } : {}),
    extractor: info.extractor_key || info.extractor || "generic",
    isLive,
    ...(duration ? { duration } : {}),
    drm,
  };

  if (drm || isLive) {
    return { ...base, variants: [] };
  }

  const audio = bestAudio(formats);
  const highFps = (f: YtdlpFormat) => (f.fps && f.fps >= 48 ? Math.round(f.fps) : undefined);
  // One entry per height, codec and frame rate: each is a different file for the same video.
  const kinds = new Map<string, YtdlpFormat>();
  for (const f of clearVideo) {
    const h = f.height ?? 0;
    if (h < MIN_HEIGHT) continue;
    const key = `${h}|${codecRank(f.vcodec)}|${highFps(f) ?? 0}`;
    const current = kinds.get(key);
    if (!current || (f.tbr ?? 0) > (current.tbr ?? 0)) kinds.set(key, f);
  }

  const sorted = [...kinds.values()].sort(
    (a, b) =>
      b.height! - a.height! ||
      codecRank(a.vcodec) - codecRank(b.vcodec) ||
      (highFps(b) ?? 0) - (highFps(a) ?? 0) ||
      (b.tbr ?? 0) - (a.tbr ?? 0),
  );
  const seenHeights = new Set<number>();
  const variants: StoredVariant[] = [];
  for (const f of sorted) {
    const h = f.height!;
    const fps = highFps(f);
    const rank = codecRank(f.vcodec);
    const primary = !seenHeights.has(h);
    seenHeights.add(h);
    // A codec we cannot name cannot be asked for: it only stands in when it is all there is.
    if (!primary && rank === CODEC_ORDER.length) continue;
    const videoSize = sizeOf(f, duration);
    const audioSize = hasAudio(f) ? 0 : sizeOf(audio, duration);
    const approxBytes = videoSize !== undefined ? videoSize + (audioSize ?? 0) : undefined;
    const v: StoredVariant = {
      id: primary ? `h${h}` : `h${h}-${rank}-${fps ?? 0}`,
      label: fps ? `${h}p${fps}` : `${h}p`,
      height: h,
      selector: primary ? selectorForHeight(h) : selectorForCodec(h, CODEC_ORDER[rank]!.prefix, fps),
      ext: expectedExt(clearVideo.filter((c) => c.height === h && codecRank(c.vcodec) === rank), audio),
    };
    if (f.width) v.width = f.width;
    if (fps) v.fps = fps;
    const codec = codecLabel(f.vcodec);
    if (codec) v.vcodec = codec;
    if (approxBytes) v.approxBytes = approxBytes;
    variants.push(v);
  }

  const sound = audioVariants(formats, duration);
  if (variants.length === 0 && (clearVideo.length > 0 || sound.length === 0)) {
    // Direct files and sites that expose no resolution metadata.
    variants.push({ id: "best", label: "best", selector: BEST_SELECTOR, ext: expectedExt(formats, audio) });
  }
  variants.push(...sound);

  return { ...base, variants };
}

/** A literal text for yt-dlp's -o: a "%" in a title or caption must not be read as a template field. */
export function outputTemplateText(text: string): string {
  return text.replaceAll("%", "%%");
}

/** Strip the server-only selector before sending variants to the extension. */
export function publicVariants(stored: StoredVariant[]): Variant[] {
  return stored.map(({ selector: _selector, ...rest }) => rest);
}
