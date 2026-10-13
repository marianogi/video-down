/**
 * Content script (isolated world), injected in every frame at document_start.
 *
 * - Runs Media Bridge's detection (network manifests + DOM videos) for this frame.
 * - Draws the download icon over each <video> (see content/overlay).
 * - Receives download progress for jobs started from this frame.
 * - Notes what it concluded for the diagnostic report (see core/diagnostics.ts).
 */

import { MessageType, type ContentReadyReply, type NativeStatusReply, type ProgressPush } from "./shared/messages";
import { VideoFormat, type VideoMetadata } from "./core/types";
import { DetectionManager } from "./core/detection/detection-manager";
import { PlaylistBodies } from "./core/detection/playlist-bodies";
import { normalizeUrl } from "./core/utils/url-utils";
import { loadSettings } from "./core/storage/settings";
import { Overlay } from "./content/overlay/overlay";
import type { DetectionFailure } from "./core/detection/detection-failure";

const FLAG = "__videoDownContent";
const g = globalThis as unknown as Record<string, unknown>;

/**
 * When the address changes, media detected up to this long before the change still counts as
 * new: a player often requests its playlist a moment before the page updates the address, and
 * a change made without the History API is only noticed by polling, up to a second late.
 */
const NAV_SLACK_MS = 1500;
/** A video that starts loading this long after an address change is not attributed to it. */
const NAV_WINDOW_MS = 30_000;

if (!g[FLAG]) {
  g[FLAG] = true;
  void main();
}

async function main(): Promise<void> {
  const media = new Map<string, VideoMetadata>();
  const bodies = new PlaylistBodies();
  let overlay: Overlay | null = null;
  let detection: DetectionManager | null = null;
  let nativeCache: { value: boolean; at: number } | null = null;
  let settings: Awaited<ReturnType<typeof loadSettings>> | null = null;

  /** Note for the diagnostic report. Never blocks and never fails. */
  function diag(event: string, url?: string, detail?: string): void {
    try {
      chrome.runtime.sendMessage(
        { type: MessageType.DIAG_EVENT, payload: { event, ...(url ? { url } : {}), ...(detail ? { detail } : {}) } },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // the extension was reloaded: this script is orphaned
    }
  }

  // Playlists can be requested while this script is still starting (the service worker
  // may be waking up). Nothing that arrives before the detector exists may be lost.
  const early: Array<{ url: string; hint?: VideoFormat }> = [];
  function feed(url: string, hint?: VideoFormat): void {
    if (detection) detection.handleNetworkRequest(url, hint);
    else early.push({ url, ...(hint ? { hint } : {}) });
  }

  /** Manifests seen on the network that could not be read, by origin+path (latest attempt). */
  const failures = new Map<string, DetectionFailure>();

  function pathKey(url: string): string {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  function onFailed(failure: DetectionFailure): void {
    failures.set(pathKey(failure.url), failure);
    const why = failure.reason === "http" ? `HTTP ${failure.status ?? "?"}` : (failure.body ?? failure.reason);
    diag("failed", failure.url, why);
    overlay?.onMediaChanged();
  }

  /**
   * Players re-request the same playlist with a fresh token (signed URLs expire).
   * Keep the newest URL for media already detected, so later downloads don't use a stale token,
   * and remember that the player is still using it.
   */
  function refreshUrl(url: string): void {
    const key = pathKey(url);
    const now = Date.now();
    for (const [k, m] of [...media]) {
      if (pathKey(m.url) !== key) continue;
      if (m.url !== url) {
        media.delete(k);
        media.set(normalizeUrl(url), { ...m, url, lastSeenAt: now });
      } else {
        media.set(k, { ...m, lastSeenAt: now });
      }
    }
  }

  function onDetected(video: VideoMetadata): void {
    if (video.format === VideoFormat.UNKNOWN) return;
    failures.delete(pathKey(video.url));
    const key = normalizeUrl(video.url);
    const existing = media.get(key);
    const now = Date.now();
    media.set(key, { ...existing, ...video, detectedAt: existing?.detectedAt ?? now, lastSeenAt: now });
    if (!existing && video.format !== VideoFormat.DIRECT) {
      const notes = [
        video.format,
        video.hasDrm ? `DRM ${video.drmSystem ?? ""}`.trim() : "",
        video.isLive ? "live" : "",
        video.unsupported ? "unsupported" : "",
      ].filter(Boolean);
      diag("detected", video.url, notes.join(", "));
    }
    overlay?.onMediaChanged();
  }

  /** A variant playlist turned out to belong to a master: only the master is offered. */
  function onRemoved(url: string): void {
    let changed = media.delete(normalizeUrl(url));
    // The master may list it with another query string than the one the player used.
    const key = pathKey(url);
    for (const [k, m] of [...media]) {
      if (m.format === VideoFormat.M3U8 && pathKey(m.url) === key) {
        media.delete(k);
        changed = true;
      }
    }
    if (changed) overlay?.onMediaChanged();
  }

  async function isNativeAvailable(): Promise<boolean> {
    if (nativeCache && Date.now() - nativeCache.at < 30_000) return nativeCache.value;
    const reply = await new Promise<NativeStatusReply | undefined>((resolve) => {
      chrome.runtime.sendMessage({ type: MessageType.NATIVE_STATUS }, (r: NativeStatusReply) => {
        if (chrome.runtime.lastError) resolve(undefined);
        else resolve(r);
      });
    });
    const value = !!reply?.installed;
    nativeCache = { value, at: Date.now() };
    return value;
  }

  function startDetection(pending: ContentReadyReply["pending"]): void {
    detection = new DetectionManager({
      onVideoDetected: onDetected,
      onVideoRemoved: onRemoved,
      onDetectionFailed: onFailed,
      onDiagnostic: (event, url, detail) => diag(event, url, detail),
      bodies,
      detectionCacheSize: settings?.advanced.detectionCacheSize,
      masterPlaylistCacheSize: settings?.advanced.masterPlaylistCacheSize,
    });
    const startDom = () => detection?.init();
    if (document.body) startDom();
    else document.addEventListener("DOMContentLoaded", startDom, { once: true });
    for (const item of pending) detection.handleNetworkRequest(item.url, item.formatHint);
    for (const item of early.splice(0)) detection.handleNetworkRequest(item.url, item.hint);
  }

  // Playlists the page's player received, recognised by their content in the page's world
  // (see content/main-world.ts), with their text when it was read whole. That world belongs to
  // the page, so a report is only used if the service worker confirms the page really
  // requested that URL.
  document.addEventListener("video-down:manifest", (event) => {
    let info: { url?: unknown; kind?: unknown; text?: unknown };
    try {
      info = JSON.parse(String((event as CustomEvent).detail));
    } catch {
      return;
    }
    const url = typeof info.url === "string" ? info.url : "";
    const hint = info.kind === "hls" ? VideoFormat.HLS : info.kind === "dash" ? VideoFormat.DASH : undefined;
    if (!url || !hint) return;
    const text = typeof info.text === "string" ? info.text : undefined;
    chrome.runtime.sendMessage({ type: MessageType.VERIFY_SNIFFED_URL, payload: { url } }, (r: { ok?: boolean }) => {
      if (chrome.runtime.lastError || !r?.ok) return;
      if (text && looksLike(text, hint)) bodies.set(url, text);
      refreshUrl(url);
      feed(url, hint);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MessageType.NETWORK_URL_DETECTED) {
      const { url, formatHint } = message.payload ?? {};
      if (typeof url === "string") {
        refreshUrl(url);
        feed(url, formatHint);
      }
    } else if (message?.type === MessageType.DOWNLOAD_PROGRESS) {
      overlay?.onProgress(message.payload as ProgressPush);
    } else if (message?.type === MessageType.RECORDING_PROGRESS) {
      overlay?.onRecordingProgress(message.payload);
    }
    return false;
  });

  // Listeners are in place: now load settings and ask the service worker for manifests
  // requested before this script existed (both in parallel).
  const [loaded, ready] = await Promise.all([
    loadSettings().catch(() => null),
    new Promise<ContentReadyReply | undefined>((resolve) => {
      chrome.runtime.sendMessage({ type: MessageType.CONTENT_READY }, (r: ContentReadyReply) => {
        if (chrome.runtime.lastError) resolve(undefined);
        else resolve(r);
      });
    }),
  ]);
  settings = loaded;
  // Only trust a positive answer: "false" may just mean "not checked yet".
  if (ready?.nativeAvailable) nativeCache = { value: true, at: Date.now() };
  startDetection(ready?.pending ?? []);

  // ------------------------------------------------------------ address changes

  // Single-page apps change the address without reloading (YouTube, Vimeo, course platforms…),
  // and many pages rewrite their own address while the same video keeps playing (removing a
  // token, adding the playback time). The address alone does not say which: the list is only
  // renewed when, after a change, a video starts loading again.
  let navigatedAt = 0;
  /** The last time a video started loading, in case the address change is noticed after it. */
  let recentLoad: { at: number; previous: VideoMetadata[] } | null = null;

  function onVideoLoad(previous: VideoMetadata[]): void {
    const now = Date.now();
    if (!navigatedAt || now - navigatedAt > NAV_WINDOW_MS) {
      navigatedAt = 0;
      recentLoad = { at: now, previous };
      return;
    }
    const cutoff = navigatedAt - NAV_SLACK_MS;
    navigatedAt = 0;
    recentLoad = null;
    dropStale(previous, cutoff);
  }

  /** Drop what belonged to the video before it started loading something else. */
  function dropStale(previous: VideoMetadata[], cutoff: number): void {
    // Only what was bound to the video that is loading: other players on the page keep theirs.
    const stale = new Set(previous.map((m) => normalizeUrl(m.url)));
    let dropped = 0;
    for (const [k, m] of [...media]) {
      if (stale.has(k) && (m.lastSeenAt ?? m.detectedAt ?? 0) < cutoff) {
        media.delete(k);
        detection?.forget(m.url);
        dropped++;
      }
    }
    for (const [k, f] of [...failures]) {
      if (f.at < cutoff) {
        failures.delete(k);
        detection?.forget(f.url);
      }
    }
    bodies.dropBefore(cutoff);
    diag("reload", undefined, `${dropped} earlier item(s) dropped`);
    overlay?.onMediaChanged();
  }

  if (settings?.showOverlay !== false) {
    const startOverlay = () => {
      overlay = new Overlay({
        allMedia: () => [...media.values()],
        failures: () => [...failures.values()].sort((a, b) => b.at - a.at),
        retryFailed: () => {
          for (const f of failures.values()) detection?.handleNetworkRequest(f.url, f.format);
        },
        bodyFor: (url) => bodies.get(url),
        onVideoLoad,
        note: diag,
        isNativeAvailable,
        minVideoWidth: settings?.minVideoWidth ?? 120,
      });
      overlay.start();
    };
    if (document.documentElement) startOverlay();
    else document.addEventListener("DOMContentLoaded", startOverlay, { once: true });
  }

  // History API changes are reported at once by the page-world script; anything else
  // (e.g. the Navigation API) is caught by polling.
  let lastUrl = location.href;
  function checkAddress(): void {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    navigatedAt = Date.now();
    diag("navigation", location.href);
    overlay?.onNavigation();
    // Noticed late: a video already started loading the new content just before.
    if (recentLoad && navigatedAt - recentLoad.at <= NAV_SLACK_MS) {
      const { at, previous } = recentLoad;
      recentLoad = null;
      navigatedAt = 0;
      dropStale(previous, at - NAV_SLACK_MS);
    }
  }
  document.addEventListener("video-down:navigation", checkAddress);
  setInterval(checkAddress, 1000);
}

function looksLike(text: string, format: VideoFormat): boolean {
  const head = text.slice(0, 4096).trimStart();
  return format === VideoFormat.HLS ? head.startsWith("#EXTM3U") : /<(?:\w+:)?MPD[\s>]/i.test(head);
}
