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

  const settings = await loadSettings().catch(() => null);

  function onDetected(video: VideoMetadata): void {
    if (video.format === VideoFormat.UNKNOWN) return;
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
      detectionCacheSize: settings?.advanced.detectionCacheSize,
      masterPlaylistCacheSize: settings?.advanced.masterPlaylistCacheSize,
    });
    const startDom = () => detection?.init();
    if (document.body) startDom();
    else document.addEventListener("DOMContentLoaded", startDom, { once: true });
    for (const item of pending) detection.handleNetworkRequest(item.url, item.formatHint);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MessageType.NETWORK_URL_DETECTED) {
      const { url, formatHint } = message.payload ?? {};
      if (typeof url === "string") detection?.handleNetworkRequest(url, formatHint);
    } else if (message?.type === MessageType.DOWNLOAD_PROGRESS) {
      overlay?.onProgress(message.payload as ProgressPush);
    }
    return false;
  });

  // Ask the service worker for manifests requested before this script was ready.
  const ready = await new Promise<ContentReadyReply | undefined>((resolve) => {
    chrome.runtime.sendMessage({ type: MessageType.CONTENT_READY }, (r: ContentReadyReply) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(r);
    });
  });
  if (ready) nativeCache = { value: ready.nativeAvailable, at: Date.now() };
  startDetection(ready?.pending ?? []);

  if (settings?.showOverlay !== false) {
    const startOverlay = () => {
      overlay = new Overlay({
        allMedia: () => [...media.values()],
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
    detection?.destroy();
    startDetection([]);
    overlay?.onNavigation();
  }, 1000);
}
