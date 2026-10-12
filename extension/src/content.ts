/**
 * Content script (isolated world), injected in every frame at document_start.
 *
 * - Runs Media Bridge's detection (network manifests + DOM videos) for this frame.
 * - Draws the download icon over each <video> (see content/overlay).
 * - Receives download progress for jobs started from this frame.
 */

import { MessageType, type ContentReadyReply, type NativeStatusReply, type ProgressPush } from "./shared/messages";
import { VideoFormat, type VideoMetadata } from "./core/types";
import { DetectionManager } from "./core/detection/detection-manager";
import { normalizeUrl } from "./core/utils/url-utils";
import { loadSettings } from "./core/storage/settings";
import { Overlay } from "./content/overlay/overlay";
import type { DetectionFailure } from "./core/detection/detection-failure";

const FLAG = "__videoDownContent";
const g = globalThis as unknown as Record<string, unknown>;

if (!g[FLAG]) {
  g[FLAG] = true;
  void main();
}

async function main(): Promise<void> {
  const media = new Map<string, VideoMetadata>();
  let overlay: Overlay | null = null;
  let detection: DetectionManager | null = null;
  let nativeCache: { value: boolean; at: number } | null = null;
  let settings: Awaited<ReturnType<typeof loadSettings>> | null = null;

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
    overlay?.onMediaChanged();
  }

  /**
   * Players re-request the same playlist with a fresh token (signed URLs expire).
   * Keep the newest URL for media already detected, so later downloads don't use a stale token.
   */
  function refreshUrl(url: string): void {
    const key = pathKey(url);
    for (const [k, m] of media) {
      if (m.url !== url && pathKey(m.url) === key) {
        media.delete(k);
        media.set(normalizeUrl(url), { ...m, url });
      }
    }
  }

  function onDetected(video: VideoMetadata): void {
    if (video.format === VideoFormat.UNKNOWN) return;
    failures.delete(pathKey(video.url));
    const key = normalizeUrl(video.url);
    const existing = media.get(key);
    media.set(key, { ...existing, ...video, detectedAt: existing?.detectedAt ?? Date.now() });
    overlay?.onMediaChanged();
  }

  function onRemoved(url: string): void {
    if (media.delete(normalizeUrl(url))) overlay?.onMediaChanged();
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
      detectionCacheSize: settings?.advanced.detectionCacheSize,
      masterPlaylistCacheSize: settings?.advanced.masterPlaylistCacheSize,
    });
    const startDom = () => detection?.init();
    if (document.body) startDom();
    else document.addEventListener("DOMContentLoaded", startDom, { once: true });
    for (const item of pending) detection.handleNetworkRequest(item.url, item.formatHint);
    for (const item of early.splice(0)) detection.handleNetworkRequest(item.url, item.hint);
  }

  // Playlists recognised by their content in the page's world (see content/main-world.ts).
  // That world belongs to the page, so a URL is only used if the service worker confirms
  // the page really requested it.
  document.addEventListener("video-down:manifest", (event) => {
    let info: { url?: unknown; kind?: unknown };
    try {
      info = JSON.parse(String((event as CustomEvent).detail));
    } catch {
      return;
    }
    const url = typeof info.url === "string" ? info.url : "";
    const hint = info.kind === "hls" ? VideoFormat.HLS : info.kind === "dash" ? VideoFormat.DASH : undefined;
    if (!url || !hint) return;
    chrome.runtime.sendMessage({ type: MessageType.VERIFY_SNIFFED_URL, payload: { url } }, (r: { ok?: boolean }) => {
      if (chrome.runtime.lastError || !r?.ok) return;
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

  if (settings?.showOverlay !== false) {
    const startOverlay = () => {
      overlay = new Overlay({
        allMedia: () => [...media.values()],
        failures: () => [...failures.values()].sort((a, b) => b.at - a.at),
        retryFailed: () => {
          for (const f of failures.values()) detection?.handleNetworkRequest(f.url, f.format);
        },
        isNativeAvailable,
        minVideoWidth: settings?.minVideoWidth ?? 120,
      });
      overlay.start();
    };
    if (document.documentElement) startOverlay();
    else document.addEventListener("DOMContentLoaded", startOverlay, { once: true });
  }

  // Single-page apps (YouTube, Vimeo…) change the URL without reloading.
  // The isolated world cannot intercept the page's history.pushState, so poll.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    media.clear();
    failures.clear();
    detection?.destroy();
    startDetection([]);
    overlay?.onNavigation();
  }, 1000);
}
