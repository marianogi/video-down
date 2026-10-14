/**
 * Capture profiles for recording what a player shows (MediaRecorder on the <video> element).
 *
 * The user chooses between quality, size and CPU use. Every profile records fragmented MP4
 * (playable while it grows, and saved without any conversion); codecs are tried in order and
 * the first one this Chrome supports is used. Bitrates scale with the video's resolution.
 * Pure: unit-tested.
 */

export type CaptureProfileId = "quality" | "balanced" | "small" | "light";

export interface CaptureProfile {
  id: CaptureProfileId;
  /** MediaRecorder types, best first */
  mimeTypes: string[];
  /** Video bits per pixel and frame: bitrate = bpp × width × height × fps */
  bitsPerPixel: number;
  audioBitsPerSecond: number;
}

export const CAPTURE_PROFILES: CaptureProfile[] = [
  {
    id: "quality",
    mimeTypes: ['video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4;codecs="avc1.640028,opus"'],
    bitsPerPixel: 0.12,
    audioBitsPerSecond: 192_000,
  },
  {
    id: "balanced",
    mimeTypes: ['video/mp4;codecs="vp9,opus"', 'video/mp4;codecs="avc1.640028,mp4a.40.2"'],
    bitsPerPixel: 0.06,
    audioBitsPerSecond: 128_000,
  },
  {
    id: "small",
    mimeTypes: ['video/mp4;codecs="av01.0.08M.08,opus"', 'video/mp4;codecs="vp9,opus"'],
    bitsPerPixel: 0.03,
    audioBitsPerSecond: 96_000,
  },
  {
    // Baseline H.264 is what hardware encoders handle best: the least CPU.
    id: "light",
    mimeTypes: ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E,opus"'],
    bitsPerPixel: 0.07,
    audioBitsPerSecond: 128_000,
  },
];

const MIN_VIDEO_BPS = 400_000;
const MAX_VIDEO_BPS = 25_000_000;

export function profileById(id: string): CaptureProfile | undefined {
  return CAPTURE_PROFILES.find((p) => p.id === id);
}

/** First MediaRecorder type of the profile that this browser supports, or null. */
export function pickMimeType(profile: CaptureProfile, isTypeSupported: (type: string) => boolean): string | null {
  return profile.mimeTypes.find((t) => isTypeSupported(t)) ?? null;
}

/** "H.264", "VP9" or "AV1", read from a MediaRecorder type. */
export function codecLabel(mimeType: string): string {
  if (/avc1/i.test(mimeType)) return "H.264";
  if (/av01|av1/i.test(mimeType)) return "AV1";
  if (/vp0?9/i.test(mimeType)) return "VP9";
  return "?";
}

export function videoBitrate(profile: CaptureProfile, width: number, height: number, fps = 30): number {
  const w = width > 0 ? width : 1280;
  const h = height > 0 ? height : 720;
  const bps = profile.bitsPerPixel * w * h * fps;
  return Math.round(Math.min(MAX_VIDEO_BPS, Math.max(MIN_VIDEO_BPS, bps)));
}

/**
 * The CODECS attribute for a recording made with this MediaRecorder type. MediaRecorder writes
 * VP9 with level 0 in its MP4 (vp09.00.00.08), which Chrome's own player then refuses; a valid
 * level is declared instead (the level is only a capability hint, not part of the data).
 */
export function hlsCodecs(mimeType: string): string | null {
  const list = mimeType.match(/codecs="?([^"]+)"?/i)?.[1];
  if (!list) return null;
  const mapped = list
    .split(",")
    .map((c) => c.trim())
    .map((c) => (/^vp0?9(\.|$)/i.test(c) ? "vp09.00.40.08" : c))
    .filter((c) => /^(avc1\.[0-9a-f]{6}|vp09\.\d\d\.\d\d\.\d\d|av01\.[\w.]+|opus|mp4a\.40\.\d+)$/i.test(c));
  return mapped.length ? mapped.join(",") : null;
}

/** The same MediaRecorder type without its audio codec, for a picture-only recording. */
export function videoOnlyMimeType(mimeType: string): string | null {
  const m = mimeType.match(/^([^;]+);\s*codecs="?([^"]+)"?$/i);
  if (!m) return null;
  const video = m[2]!
    .split(",")
    .map((c) => c.trim())
    .filter((c) => !/^(mp4a|opus|vorbis|flac)/i.test(c));
  return video.length ? `${m[1]};codecs="${video.join(",")}"` : null;
}

/** Approximate size of one hour, in bytes. */
export function bytesPerHour(bitsPerSecond: number): number {
  return Math.round((bitsPerSecond * 3600) / 8);
}
