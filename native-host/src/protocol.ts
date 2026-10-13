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

/**
 * A cookie of the user's browser session for the site being downloaded. Only sent when yt-dlp
 * said it needs a session, only cookies the browser itself would send to that URL, and the host
 * only keeps them in a temporary file for the duration of that yt-dlp run.
 */
export interface SessionCookie {
  /** As the browser reports it: "www.example.com", or ".example.com" for a domain cookie */
  domain: string;
  /** true: only for that exact host (no subdomains) */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  name: string;
  value: string;
  /** Seconds since the epoch; absent for a session cookie */
  expires?: number;
}

export const MAX_COOKIES = 200;
export const MAX_COOKIE_CHARS = 4096;

export interface ProbeRequest {
  id: string;
  type: "probe";
  /** Page or media URL handed to yt-dlp. http(s) only. */
  url: string;
  /** Page URL to send as Referer (some CDNs require it). http(s) only. */
  referer?: string;
  /** The site's session, only when an anonymous probe was refused. All must match `url`. */
  cookies?: SessionCookie[];
}

export interface DownloadRequest {
  id: string;
  type: "download";
  /** Identifier returned by a previous probe. The host re-reads that probe from disk. */
  probeId: string;
  /** One of the variant ids returned by that probe. */
  variantId: string;
  /** The site's session, when the probe needed it. The host checks them against the probe's URL. */
  cookies?: SessionCookie[];
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

// The cookie file yt-dlp reads is tab-separated, one cookie per line: a tab, CR or LF in any
// field could forge another line (another domain), so control characters are refused outright.
// deno-lint-ignore no-control-regex
const COOKIE_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const COOKIE_DOMAIN_RE = /^\.?[A-Za-z0-9.-]{1,253}$/;
const COOKIE_NAME_RE = /^[^\s;=,]{1,256}$/;

/**
 * Whether the browser would send this cookie to that URL's host (RFC 6265 domain match).
 * Path and the secure flag are left to yt-dlp, which applies them per request.
 */
export function cookieMatchesUrl(cookie: Pick<SessionCookie, "domain" | "hostOnly">, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const domain = cookie.domain.toLowerCase().replace(/^\./, "");
  if (!domain) return false;
  if (cookie.hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Validate session cookies. With `url`, every cookie must belong to it; without it (download
 * requests) the host checks them against the stored probe's URL instead.
 */
export function parseCookies(raw: unknown, url?: string): { ok: true; value: SessionCookie[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "cookies must be a list" };
  if (raw.length === 0 || raw.length > MAX_COOKIES) return { ok: false, reason: "invalid number of cookies" };
  const out: SessionCookie[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, reason: "invalid cookie" };
    const c = item as Record<string, unknown>;
    if (typeof c.domain !== "string" || !COOKIE_DOMAIN_RE.test(c.domain)) return { ok: false, reason: "invalid cookie domain" };
    if (typeof c.path !== "string" || !c.path.startsWith("/") || c.path.length > 1024 || CONTROL_RE.test(c.path)) {
      return { ok: false, reason: "invalid cookie path" };
    }
    if (typeof c.name !== "string" || !COOKIE_NAME_RE.test(c.name) || COOKIE_CONTROL_RE.test(c.name)) {
      return { ok: false, reason: "invalid cookie name" };
    }
    if (typeof c.value !== "string" || c.value.length > MAX_COOKIE_CHARS || COOKIE_CONTROL_RE.test(c.value)) {
      return { ok: false, reason: "invalid cookie value" };
    }
    if (typeof c.hostOnly !== "boolean" || typeof c.secure !== "boolean") return { ok: false, reason: "invalid cookie flags" };
    if (c.expires !== undefined && (typeof c.expires !== "number" || !Number.isFinite(c.expires) || c.expires < 0)) {
      return { ok: false, reason: "invalid cookie expiry" };
    }
    const cookie: SessionCookie = {
      domain: c.domain,
      hostOnly: c.hostOnly,
      path: c.path,
      secure: c.secure,
      name: c.name,
      value: c.value,
      ...(c.expires !== undefined ? { expires: Math.floor(c.expires as number) } : {}),
    };
    if (url !== undefined && !cookieMatchesUrl(cookie, url)) return { ok: false, reason: "cookie for another site" };
    out.push(cookie);
  }
  return { ok: true, value: out };
}

/**
 * The cookies in the Netscape format yt-dlp reads with --cookies. A session cookie gets an
 * expiry a day ahead: the file only lives for one yt-dlp run, and a cookie without expiry
 * could be discarded when the file is loaded.
 */
export function cookieFileText(cookies: SessionCookie[], nowSeconds: number): string {
  const lines = ["# Netscape HTTP Cookie File", "# Written by video-down for one yt-dlp run; deleted afterwards."];
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, "");
    lines.push(
      [
        c.hostOnly ? host : `.${host}`,
        c.hostOnly ? "FALSE" : "TRUE",
        c.path,
        c.secure ? "TRUE" : "FALSE",
        String(c.expires ?? nowSeconds + 86_400),
        c.name,
        c.value,
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
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
      if (msg.cookies !== undefined) {
        const cookies = parseCookies(msg.cookies, msg.url);
        if (!cookies.ok) return { ok: false, reason: cookies.reason, id };
        value.cookies = cookies.value;
      }
      return { ok: true, value };
    }
    case "download": {
      if (!isSafeId(msg.probeId)) return { ok: false, reason: "invalid probeId", id };
      if (!isSafeVariantId(msg.variantId)) return { ok: false, reason: "invalid variantId", id };
      const value: DownloadRequest = { id, type: "download", probeId: msg.probeId, variantId: msg.variantId };
      if (msg.cookies !== undefined) {
        // Shape only here: the host matches their domain against the stored probe's URL.
        const cookies = parseCookies(msg.cookies);
        if (!cookies.ok) return { ok: false, reason: cookies.reason, id };
        value.cookies = cookies.value;
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, reason: "unknown type", id };
  }
}
