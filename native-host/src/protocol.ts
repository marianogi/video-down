/**
 * Message protocol between the video-down extension and its native host.
 *
 * This file is the single source of truth for both sides:
 *  - the native host (Deno) imports it directly;
 *  - the extension (Vite) imports it through the `@host/protocol` alias.
 *
 * It must stay free of Deno, Node and browser APIs so it can run anywhere.
 *
 * Transport: Chrome native messaging (32-bit length prefix + UTF-8 JSON).
 * One native port is opened per operation; closing the port kills the host,
 * which is also how a download is cancelled.
 */

export const PROTOCOL_VERSION = 1;

/** Upper bound for any URL the host will accept. */
export const MAX_URL_LENGTH = 4096;

// ---------------------------------------------------------------- requests

export interface PingRequest {
  id: string;
  type: "ping";
}

export interface ProbeRequest {
  id: string;
  type: "probe";
  /** Page or media URL handed to yt-dlp. http(s) only. */
  url: string;
  /** Page URL to send as Referer (some CDNs require it). http(s) only. */
  referer?: string;
}

export interface DownloadRequest {
  id: string;
  type: "download";
  /** Identifier returned by a previous probe. The host re-reads that probe from disk. */
  probeId: string;
  /** One of the variant ids returned by that probe. */
  variantId: string;
}

export interface UpdateRequest {
  id: string;
  type: "update";
}

export type HostRequest = PingRequest | ProbeRequest | DownloadRequest | UpdateRequest;

// ---------------------------------------------------------------- responses

export interface Variant {
  /** Opaque id chosen by the host, e.g. "h1080". */
  id: string;
  /** Short label for the UI, e.g. "1080p". */
  label: string;
  height?: number;
  width?: number;
  fps?: number;
  /** Video codec family for the UI: "H.264", "VP9", "AV1"… */
  vcodec?: string;
  /** Approximate final size in bytes when yt-dlp knows it. */
  approxBytes?: number;
}

export interface PongResponse {
  id: string;
  type: "pong";
  protocol: number;
  hostVersion: string;
  ytdlpVersion: string | null;
  ffmpeg: boolean;
  deno: boolean;
  platform: string;
  downloadDir: string;
}

export interface ProbeResultResponse {
  id: string;
  type: "probe-result";
  probeId: string;
  title: string;
  extractor: string;
  isLive: boolean;
  duration?: number;
  /** yt-dlp reports DRM per format; true when every video format is protected. */
  drm: boolean;
  variants: Variant[];
}

export interface DownloadStartedResponse {
  id: string;
  type: "download-started";
  jobId: string;
  label: string;
}

export interface ProgressResponse {
  id: string;
  type: "progress";
  jobId: string;
  stage: "downloading" | "merging";
  downloadedBytes?: number;
  totalBytes?: number;
  /** Bytes per second */
  speed?: number;
  /** Seconds */
  eta?: number;
  /** 0-100 over the whole job (video + audio) */
  percent?: number;
}

export interface DoneResponse {
  id: string;
  type: "done";
  jobId: string;
  filepath: string;
}

export interface UpdateResultResponse {
  id: string;
  type: "update-result";
  ytdlpVersion: string | null;
  output: string;
}

export interface ErrorResponse {
  id: string;
  type: "error";
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | "bad-request"
  | "not-found"
  | "unsupported-url"
  | "drm"
  | "live"
  | "ytdlp-failed"
  | "missing-binary"
  | "internal";

export type HostResponse =
  | PongResponse
  | ProbeResultResponse
  | DownloadStartedResponse
  | ProgressResponse
  | DoneResponse
  | UpdateResultResponse
  | ErrorResponse;

// ---------------------------------------------------------------- validation

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VARIANT_RE = /^[a-z0-9_-]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\s]/;

/** Accept only absolute http(s) URLs without whitespace or control characters. */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  if (CONTROL_RE.test(value)) return false;
  // A leading dash could be read as an option by a careless caller; the host
  // also passes URLs after "--", but reject it here as defence in depth.
  if (value.startsWith("-")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function isSafeVariantId(value: unknown): value is string {
  return typeof value === "string" && VARIANT_RE.test(value);
}

/**
 * Validate an untrusted message coming from the extension.
 * Returns the typed request or a human-readable reason.
 */
export function parseRequest(raw: unknown): { ok: true; value: HostRequest } | { ok: false; reason: string; id?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "message must be an object" };
  }
  const msg = raw as Record<string, unknown>;
  const id = msg.id;
  if (!isSafeId(id)) return { ok: false, reason: "invalid id" };

  switch (msg.type) {
    case "ping":
      return { ok: true, value: { id, type: "ping" } };
    case "update":
      return { ok: true, value: { id, type: "update" } };
    case "probe": {
      if (!isSafeHttpUrl(msg.url)) return { ok: false, reason: "invalid url", id };
      if (msg.referer !== undefined && !isSafeHttpUrl(msg.referer)) {
        return { ok: false, reason: "invalid referer", id };
      }
      const value: ProbeRequest = { id, type: "probe", url: msg.url };
      if (msg.referer !== undefined) value.referer = msg.referer as string;
      return { ok: true, value };
    }
    case "download": {
      if (!isSafeId(msg.probeId)) return { ok: false, reason: "invalid probeId", id };
      if (!isSafeVariantId(msg.variantId)) return { ok: false, reason: "invalid variantId", id };
      return {
        ok: true,
        value: { id, type: "download", probeId: msg.probeId, variantId: msg.variantId },
      };
    }
    default:
      return { ok: false, reason: "unknown type", id };
  }
}
