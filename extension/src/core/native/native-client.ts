/**
 * Service-worker side of the native component (yt-dlp through Deno).
 *
 * Each operation opens its own native port, so each one is its own host
 * process. Disconnecting the port makes the host stop yt-dlp and exit: that
 * is how a download is cancelled. While a port is open Chrome keeps the
 * service worker alive.
 */

import type {
  DoneResponse,
  ErrorResponse,
  HostResponse,
  PongResponse,
  ProbeResultResponse,
  SessionCookie,
  ProgressResponse,
  UpdateResultResponse,
} from "@host/protocol";
import { NATIVE_HOST_NAME } from "../../shared/constants";

export class NativeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeUnavailableError";
  }
}

export class NativeHostError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "NativeHostError";
  }
}

function newId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
}

interface Session {
  cancel(): void;
  finished: Promise<void>;
}

/**
 * Open a port, send one request and feed every reply with the same id to
 * `onMessage` until it returns "done".
 */
function session(
  message: Record<string, unknown>,
  onMessage: (m: HostResponse) => "continue" | "done",
  timeoutMs = 0,
): Session {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    return {
      cancel() {},
      finished: Promise.reject(new NativeUnavailableError(String(err))),
    };
  }
  let settled = false;
  const finished = new Promise<void>((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => finish(new NativeHostError("timeout", "timeout")), timeoutMs)
      : undefined;
    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // already disconnected
      }
      if (err) reject(err);
      else resolve();
    }
    port.onMessage.addListener((m: HostResponse) => {
      if (m?.id !== message.id && m?.id !== "unknown") return;
      try {
        if (onMessage(m) === "done") finish();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message || "native host exited";
      finish(new NativeUnavailableError(reason));
    });
    port.postMessage(message);
  });
  return {
    cancel() {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        // already gone
      }
    },
    finished,
  };
}

function asError(m: ErrorResponse): NativeHostError {
  return new NativeHostError(m.message, m.code);
}

// ---------------------------------------------------------------- status

let statusCache: { at: number; value: { installed: boolean; pong?: PongResponse; error?: string } } | null = null;
/** A positive answer is trusted for a minute; a negative one only briefly, because the usual
 * cause is a slow first start (antivirus scanning Deno, a busy machine), not a missing install. */
const STATUS_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 5_000;
/** Deno's first start can take several seconds on slow or busy machines. */
const PING_TIMEOUT_MS = 20_000;

function statusFresh(): boolean {
  if (!statusCache) return false;
  const ttl = statusCache.value.installed ? STATUS_TTL_MS : NEGATIVE_TTL_MS;
  return Date.now() - statusCache.at < ttl;
}

let pendingPing: Promise<{ installed: boolean; pong?: PongResponse; error?: string }> | null = null;

export async function nativeStatus(force = false): Promise<{ installed: boolean; pong?: PongResponse; error?: string }> {
  if (!force && statusFresh()) return statusCache!.value;
  // Concurrent callers share one ping instead of starting several host processes.
  if (pendingPing) return pendingPing;
  pendingPing = pingHost().finally(() => {
    pendingPing = null;
  });
  return pendingPing;
}

async function pingHost(): Promise<{ installed: boolean; pong?: PongResponse; error?: string }> {
  let pong: PongResponse | undefined;
  let value: { installed: boolean; pong?: PongResponse; error?: string };
  try {
    await session(
      { id: newId(), type: "ping" },
      (m) => {
        if (m.type === "pong") {
          pong = m;
          return "done";
        }
        if (m.type === "error") throw asError(m);
        return "continue";
      },
      PING_TIMEOUT_MS,
    ).finished;
    value = pong?.ytdlpVersion ? { installed: true, pong } : { installed: false, pong, error: "yt-dlp missing" };
  } catch (err) {
    value = { installed: false, error: err instanceof Error ? err.message : String(err) };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** Last known status without spawning the host (null if never checked or expired). */
export function cachedNativeStatus(): { installed: boolean } | null {
  return statusFresh() ? statusCache!.value : null;
}

export function invalidateNativeStatus(): void {
  statusCache = null;
}

// ---------------------------------------------------------------- probe

export async function nativeProbe(url: string, referer?: string, cookies?: SessionCookie[]): Promise<ProbeResultResponse> {
  let result: ProbeResultResponse | undefined;
  await session(
    {
      id: newId(),
      type: "probe",
      url,
      ...(referer ? { referer } : {}),
      ...(cookies?.length ? { cookies } : {}),
    },
    (m) => {
      if (m.type === "probe-result") {
        result = m;
        return "done";
      }
      if (m.type === "error") throw asError(m);
      return "continue";
    },
    120_000,
  ).finished;
  if (!result) throw new NativeHostError("empty probe result", "internal");
  return result;
}

// ---------------------------------------------------------------- download

export interface NativeDownloadCallbacks {
  onStarted(jobId: string, label: string): void;
  onProgress(p: ProgressResponse): void;
  onDone(d: DoneResponse): void;
  onError(err: Error): void;
}

export function nativeDownload(
  probeId: string,
  variantId: string,
  cb: NativeDownloadCallbacks,
  cookies?: SessionCookie[],
): { cancel(): void } {
  let done = false;
  const request = { id: newId(), type: "download" as const, probeId, variantId, ...(cookies?.length ? { cookies } : {}) };
  const s = session(request, (m) => {
    switch (m.type) {
      case "download-started":
        cb.onStarted(m.jobId, m.label);
        return "continue";
      case "progress":
        cb.onProgress(m);
        return "continue";
      case "done":
        done = true;
        cb.onDone(m);
        return "done";
      case "error":
        throw asError(m);
      default:
        return "continue";
    }
  });
  s.finished.catch((err) => {
    if (!done) cb.onError(err instanceof Error ? err : new Error(String(err)));
  });
  return { cancel: () => s.cancel() };
}

// ---------------------------------------------------------------- update

export async function nativeUpdate(): Promise<UpdateResultResponse> {
  let result: UpdateResultResponse | undefined;
  await session(
    { id: newId(), type: "update" },
    (m) => {
      if (m.type === "update-result") {
        result = m;
        return "done";
      }
      if (m.type === "error") throw asError(m);
      return "continue";
    },
    180_000,
  ).finished;
  invalidateNativeStatus();
  if (!result) throw new NativeHostError("empty update result", "internal");
  return result;
}
