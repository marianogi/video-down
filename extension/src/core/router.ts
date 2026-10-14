/**
 * Decide how a given <video> can be downloaded. Pure: no chrome.* or DOM APIs,
 * so every branch is unit-tested.
 *
 * Rule of thumb, as agreed for this project: use the lightweight in-browser
 * path whenever it is enough, and the native component (yt-dlp) only when it
 * is needed. Never block when the native component is missing: degrade or
 * explain what is needed.
 */

import { VideoFormat, type VideoMetadata } from "./types";

export interface DirectSource {
  url: string;
  /** Label found on <source> (size/res/label/title attributes) */
  label?: string;
  height?: number;
  type?: string;
}

export interface VideoFacts {
  /** video.currentSrc || video.src */
  src: string;
  /** http(s) <source> children */
  sources: DirectSource[];
  /** Key system when the element uses EME (set by the main-world probe) */
  drm?: string | null;
  duration?: number;
  /** ms since the element started loading */
  loadingForMs: number;
  /** The page this video is only a preview of (a video inside a link to another page) */
  previewOf?: string;
}

export type Route =
  | { kind: "drm"; system?: string }
  | { kind: "live" }
  | { kind: "direct"; sources: DirectSource[] }
  | { kind: "manifest"; media: VideoMetadata }
  | { kind: "native"; url: string; referer?: string; reason: "youtube" | "unknown-stream" | "preview" }
  | { kind: "need-native"; reason: "youtube" | "unknown-stream" | "preview" }
  | { kind: "pending" };

export interface RouteInput {
  pageUrl: string;
  video: VideoFacts;
  /** Media detected in this frame, most relevant first (see binding.ts). */
  media: VideoMetadata[];
  nativeAvailable: boolean;
}

/** How long a blob: video may wait for its manifest before we give up on the light path. */
export const BLOB_GRACE_MS = 4000;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);

/**
 * Canonical watch URL for any YouTube page or embed, or null when the page is
 * not a single YouTube video (home page, search…).
 */
export function youtubeWatchUrl(pageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(u.hostname)) return null;
  const idRe = /^[A-Za-z0-9_-]{11}$/;
  let id: string | null = null;
  if (u.hostname === "youtu.be") id = u.pathname.slice(1).split("/")[0] ?? null;
  else if (u.pathname === "/watch") id = u.searchParams.get("v");
  else {
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    id = m?.[1] ?? null;
  }
  return id && idRe.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function isYoutubeHost(pageUrl: string): boolean {
  try {
    return YOUTUBE_HOSTS.has(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

function isHttp(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Chrome can play HLS natively, so <video src> may point at a playlist rather than a file. */
export function isManifestUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".m3u8") || path.endsWith(".mpd");
  } catch {
    return false;
  }
}

const MANIFEST_FORMATS = new Set<VideoFormat>([VideoFormat.HLS, VideoFormat.M3U8, VideoFormat.DASH]);

export function route(input: RouteInput): Route {
  const { video, media, pageUrl, nativeAvailable } = input;

  // 1. The element itself is using EME: protected, whatever else we know.
  if (video.drm) return { kind: "drm", system: video.drm };

  // 1b. A preview (a video inside a link to another page): the full video is on that page, never
  //     the teaser playing here, whose manifests and files are not the video's.
  if (video.previewOf) {
    const yt = youtubeWatchUrl(video.previewOf);
    if (yt) return nativeAvailable ? { kind: "native", url: yt, reason: "youtube" } : { kind: "need-native", reason: "youtube" };
    return nativeAvailable
      ? { kind: "native", url: video.previewOf, reason: "preview" }
      : { kind: "need-native", reason: "preview" };
  }

  // 2. YouTube only works through yt-dlp (the web player is SABR-only since 2025).
  const yt = youtubeWatchUrl(pageUrl);
  if (yt || isYoutubeHost(pageUrl)) {
    if (!yt) return { kind: "pending" };
    return nativeAvailable
      ? { kind: "native", url: yt, reason: "youtube" }
      : { kind: "need-native", reason: "youtube" };
  }

  // 3. Manifests detected for this video.
  const manifests = media.filter((m) => MANIFEST_FORMATS.has(m.format));
  const protectedMedia = manifests.find((m) => m.hasDrm);
  if (protectedMedia) return { kind: "drm", system: protectedMedia.drmSystem };
  const live = manifests.find((m) => m.isLive);
  if (live && manifests.every((m) => m.isLive)) return { kind: "live" };

  // 4. Plain files: <video src="…mp4"> or <source> children.
  const sources: DirectSource[] = video.sources.filter((s) => !isManifestUrl(s.url));
  if (isHttp(video.src) && !isManifestUrl(video.src) && !sources.some((s) => s.url === video.src)) {
    sources.unshift({ url: video.src });
  }
  if (sources.length > 0) return { kind: "direct", sources };

  const usable = manifests.find((m) => !m.isLive && !m.unsupported);
  if (usable) return { kind: "manifest", media: usable };

  // 5. MSE player with an unknown protocol, or an encryption scheme we cannot handle.
  const unknownStream =
    manifests.some((m) => m.unsupported) ||
    (video.src.startsWith("blob:") && video.loadingForMs >= BLOB_GRACE_MS);
  if (unknownStream) {
    return nativeAvailable
      ? { kind: "native", url: pageUrl, reason: "unknown-stream" }
      : { kind: "need-native", reason: "unknown-stream" };
  }

  return { kind: "pending" };
}
