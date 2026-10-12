/**
 * Background service worker.
 *
 * - Watches the network for HLS/DASH manifests and tells the frame that asked for them.
 * - Runs browser downloads (Media Bridge's engine: segments → ffmpeg.wasm → file).
 * - Talks to the native component (yt-dlp) for YouTube, unknown streams and very large files.
 * - Routes progress back to the frame whose overlay started each download, and to the popup.
 *
 * Forked from Media Bridge (MIT); cloud upload and live recording were removed.
 */

import { DownloadManager } from "./core/downloader/download-manager";
import { getAllDownloads, getDownload, storeDownload, deleteDownload } from "./core/database/downloads";
import { deleteChunks, getAllChunkDownloadIds } from "./core/database/chunks";
import { ChromeStorage } from "./core/storage/chrome-storage";
import { loadSettings } from "./core/storage/settings";
import {
  MessageType,
  type ContentReadyReply,
  type DownloadRequestPayload,
  type DownloadStartedReply,
  type GetVariantsPayload,
  type GetVariantsReply,
  type NativeDownloadPayload,
  type NativeProbePayload,
  type NativeProbeReply,
  type ProgressPush,
} from "./shared/messages";
import { DownloadStage, VideoFormat, type DownloadState, type StorageConfig } from "./core/types";
import { CancellationError } from "./core/utils/errors";
import { generateDownloadId } from "./core/utils/id-utils";
import { logger } from "./core/utils/logger";
import { canCancelDownload, CANNOT_CANCEL_MESSAGE } from "./core/utils/download-utils";
import { normalizeUrl, detectFormatFromUrl } from "./core/utils/url-utils";
import { generateFilenameFromTabInfo, generateFilenameWithExtension } from "./core/utils/file-utils";
import { createOffscreenDocument, closeOffscreenDocument } from "./core/ffmpeg/offscreen-manager";
import { KEEPALIVE_INTERVAL_MS, STORAGE_CONFIG_KEY } from "./shared/constants";
import { variantsFor, type BrowserVariant } from "./core/variants";
import { isSafeHttpUrl } from "@host/protocol";
import {
  nativeStatus,
  nativeProbe,
  nativeDownload,
  nativeUpdate,
  invalidateNativeStatus,
  cachedNativeStatus,
  NativeHostError,
} from "./core/native/native-client";

// ------------------------------------------------------------------ state

interface Origin {
  tabId: number;
  frameId: number;
}

interface BrowserJob {
  abort: AbortController;
  dedupeKey: string;
}

const browserJobs = new Map<string, BrowserJob>();
const nativeJobs = new Map<string, { cancel(): void }>();
const jobOrigins = new Map<string, Origin>();
const activeDedupeKeys = new Set<string>();

/** Manifests seen per tab/frame, so late content scripts can catch up. */
const pendingByFrame = new Map<string, Array<{ url: string; formatHint?: VideoFormat; at: number }>>();
const PENDING_LIMIT = 30;
const PENDING_TTL_MS = 5 * 60_000;

// ------------------------------------------------------------------ keep-alive

/**
 * Keep the worker alive while browser downloads run (FFmpeg can take minutes).
 * Native downloads keep it alive by themselves through their open port.
 */
const keepAlive = (
  (i?: ReturnType<typeof setInterval> | 0) => (state: boolean) => {
    if (state && !i) {
      if (performance.now() > KEEPALIVE_INTERVAL_MS) chrome.runtime.getPlatformInfo();
      i = setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_INTERVAL_MS);
    } else if (!state && i) {
      clearInterval(i);
      i = 0;
    }
  }
)();

function updateKeepAlive(): void {
  keepAlive(browserJobs.size > 0);
}

/**
 * Close the ffmpeg.wasm document a while after the last browser job ends. Closing it at
 * once raced with a download starting right then, whose merge request was lost.
 */
let offscreenCloseTimer: ReturnType<typeof setTimeout> | null = null;

function cancelOffscreenClose(): void {
  if (offscreenCloseTimer) clearTimeout(offscreenCloseTimer);
  offscreenCloseTimer = null;
}

function scheduleOffscreenClose(): void {
  cancelOffscreenClose();
  offscreenCloseTimer = setTimeout(() => {
    offscreenCloseTimer = null;
    if (browserJobs.size === 0) {
      closeOffscreenDocument().catch((err) => logger.error("Failed to close offscreen document:", err));
    }
  }, 30_000);
}

// ------------------------------------------------------------------ progress routing

function pushProgress(state: DownloadState, extra: Partial<ProgressPush> = {}): void {
  const push: ProgressPush = {
    id: state.id,
    progress: state.progress,
    ...(state.via ? { via: state.via } : {}),
    ...(state.variantLabel ? { label: state.variantLabel } : {}),
    ...(state.localPath ? { filePath: state.localPath } : {}),
    ...extra,
  };
  const message = { type: MessageType.DOWNLOAD_PROGRESS, payload: push };
  const origin = jobOrigins.get(state.id);
  if (origin) {
    chrome.tabs.sendMessage(origin.tabId, message, { frameId: origin.frameId }, () => void chrome.runtime.lastError);
  }
  // Popup and options pages
  chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  updateBadge();
}

async function updateBadge(): Promise<void> {
  const active = browserJobs.size + nativeJobs.size;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    await chrome.action.setBadgeText({ text: active > 0 ? String(active) : "" });
  } catch {
    // ignore
  }
}

async function afterFinish(state: DownloadState): Promise<void> {
  const settings = await loadSettings();
  if (state.progress.stage === DownloadStage.COMPLETED) {
    if (settings.notifications.notifyOnCompletion) {
      chrome.notifications.create(`done-${state.id}`, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: chrome.i18n.getMessage("notifyDone"),
        message: `${state.metadata.title ?? ""}${state.variantLabel ? ` (${state.variantLabel})` : ""}`,
      });
    }
    if (settings.notifications.autoOpenFile && state.chromeDownloadId != null) {
      chrome.downloads.show(state.chromeDownloadId);
    }
  }
  if (!settings.historyEnabled) await deleteDownload(state.id).catch(() => undefined);
  setTimeout(() => jobOrigins.delete(state.id), 60_000);
}

// ------------------------------------------------------------------ network observer

const HLS_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"];
const DASH_TYPES = ["application/dash+xml"];

function frameKey(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}

function remember(tabId: number, frameId: number, url: string, formatHint?: VideoFormat): void {
  const key = frameKey(tabId, frameId);
  const now = Date.now();
  const list = (pendingByFrame.get(key) ?? []).filter((x) => now - x.at < PENDING_TTL_MS && x.url !== url);
  list.push({ url, ...(formatHint ? { formatHint } : {}), at: now });
  pendingByFrame.set(key, list.slice(-PENDING_LIMIT));
}

function onManifestHeaders(details: chrome.webRequest.OnHeadersReceivedDetails): void {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    const url = details.url;
    if (url.includes(".googlevideo.com/")) return; // YouTube media goes through yt-dlp

    let format = detectFormatFromUrl(url);
    let formatHint: VideoFormat | undefined;
    if (format !== VideoFormat.HLS && format !== VideoFormat.DASH) {
      const ct =
        details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value?.toLowerCase() ?? "";
      if (HLS_TYPES.some((t) => ct.includes(t))) formatHint = VideoFormat.HLS;
      else if (DASH_TYPES.some((t) => ct.includes(t))) formatHint = VideoFormat.DASH;
      else return;
      format = formatHint;
    }

    remember(details.tabId, details.frameId, url, formatHint);
    chrome.tabs.sendMessage(
      details.tabId,
      { type: MessageType.NETWORK_URL_DETECTED, payload: { url, ...(formatHint ? { formatHint } : {}) } },
      { frameId: details.frameId },
      () => void chrome.runtime.lastError,
    );
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    onManifestHeaders(details);
    return undefined;
  },
  { urls: ["http://*/*", "https://*/*"], types: ["xmlhttprequest", "media", "other"] },
  ["responseHeaders"],
);

// A new document in a frame starts with a clean list.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return undefined;
    if (details.type === "main_frame") {
      for (const key of [...pendingByFrame.keys()]) {
        if (key.startsWith(`${details.tabId}:`)) pendingByFrame.delete(key);
      }
    } else {
      pendingByFrame.delete(frameKey(details.tabId, details.frameId));
    }
    return undefined;
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame", "sub_frame"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of [...pendingByFrame.keys()]) {
    if (key.startsWith(`${tabId}:`)) pendingByFrame.delete(key);
  }
});

// ------------------------------------------------------------------ variants

async function headSize(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const len = Number(res.headers.get("content-length"));
    return Number.isFinite(len) && len > 0 ? len : undefined;
  } catch {
    return undefined;
  }
}

async function handleGetVariants(payload: GetVariantsPayload & { sources?: string[] }): Promise<GetVariantsReply> {
  if (!isSafeHttpUrl(payload.url)) return { success: false, error: "invalid url" };
  try {
    if (payload.format === VideoFormat.DIRECT) {
      const urls = (payload.sources ?? [payload.url]).filter(isSafeHttpUrl).slice(0, 8);
      const sizes = await Promise.all(urls.map(headSize));
      const variants: BrowserVariant[] = urls.map((u, i) => ({
        id: u,
        label: "original",
        ...(sizes[i] ? { approxBytes: sizes[i] } : {}),
      }));
      return { success: true, variants };
    }
    const res = await fetch(payload.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    const variants = variantsFor(payload.format, text, res.url || payload.url, payload.duration);
    return { success: true, variants };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ------------------------------------------------------------------ browser downloads

function resolveFilename(payload: DownloadRequestPayload): string {
  const { metadata, url } = payload;
  const isStream =
    metadata.format === VideoFormat.HLS || metadata.format === VideoFormat.M3U8 || metadata.format === VideoFormat.DASH;
  const extension = isStream ? "mp4" : metadata.fileExtension || "mp4";
  const title = payload.tabTitle
    ? `${payload.tabTitle}${payload.variantLabel ? ` ${payload.variantLabel}` : ""}`
    : undefined;
  if (payload.filename) return payload.filename;
  return title || payload.website
    ? generateFilenameFromTabInfo(title, payload.website, extension)
    : generateFilenameWithExtension(url, extension);
}

async function startBrowserDownload(payload: DownloadRequestPayload, origin?: Origin): Promise<DownloadStartedReply> {
  if (!isSafeHttpUrl(payload.url) || !payload.metadata) return { success: false, error: "invalid request" };
  const settings = await loadSettings();

  // ffmpeg.wasm works in memory; hand very large streams to yt-dlp when it is installed.
  const isStream = payload.metadata.format !== VideoFormat.DIRECT;
  if (isStream && payload.approxBytes && payload.approxBytes > settings.preferNativeAboveMb * 1024 * 1024) {
    const status = await nativeStatus();
    if (status.installed) {
      logger.info(`Large stream (${payload.approxBytes} bytes): using the native component`);
      return startNativeForStream(payload, origin);
    }
  }

  const q = payload.manifestQuality;
  const dedupeKey = `${normalizeUrl(payload.url)}|${q?.videoPlaylistUrl ?? ""}|${q?.audioPlaylistUrl ?? ""}|${q?.selectedBandwidth ?? ""}`;
  if (activeDedupeKeys.has(dedupeKey)) {
    return { success: false, error: chrome.i18n.getMessage("alreadyDownloading") };
  }

  const id = generateDownloadId(payload.url);
  const abort = new AbortController();
  cancelOffscreenClose();
  browserJobs.set(id, { abort, dedupeKey });
  activeDedupeKeys.add(dedupeKey);
  if (origin) jobOrigins.set(id, origin);
  updateKeepAlive();

  const manager = new DownloadManager({
    maxConcurrent: settings.maxConcurrent,
    ffmpegTimeout: settings.ffmpegTimeout,
    maxRetries: settings.advanced.maxRetries,
    retryDelayMs: settings.advanced.retryDelayMs,
    retryBackoffFactor: settings.advanced.retryBackoffFactor,
    fragmentFailureRate: settings.advanced.fragmentFailureRate,
    dbSyncIntervalMs: settings.advanced.dbSyncIntervalMs,
    minPollIntervalMs: settings.recording.minPollIntervalMs,
    maxPollIntervalMs: settings.recording.maxPollIntervalMs,
    pollFraction: settings.recording.pollFraction,
    onProgress: async (state) => {
      if (abort.signal.aborted) return;
      state.via = "browser";
      if (payload.variantLabel) state.variantLabel = payload.variantLabel;
      await storeDownload(state);
      pushProgress(state);
    },
  });

  if (isStream) {
    createOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: MessageType.WARMUP_FFMPEG }, () => void chrome.runtime.lastError))
      .catch((err) => logger.error("FFmpeg pre-warm failed:", err));
  }

  const filename = resolveFilename(payload);
  manager
    .download(payload.url, filename, payload.metadata, payload.manifestQuality, false, abort.signal, id)
    .then(async (state) => {
      state.via = "browser";
      if (payload.variantLabel) state.variantLabel = payload.variantLabel;
      if (!abort.signal.aborted) pushProgress(state);
      await afterFinish(state);
    })
    .catch(async (error: unknown) => {
      if (error instanceof CancellationError || abort.signal.aborted) return;
      logger.error(`Download failed for ${payload.url}:`, error);
      const state = await getDownload(id);
      if (state) {
        state.via = "browser";
        if (payload.variantLabel) state.variantLabel = payload.variantLabel;
        pushProgress(state);
        await afterFinish(state);
      }
    })
    .finally(() => {
      browserJobs.delete(id);
      activeDedupeKeys.delete(dedupeKey);
      updateKeepAlive();
      updateBadge();
      if (browserJobs.size === 0) scheduleOffscreenClose();
    });

  return { success: true, downloadId: id, via: "browser" };
}

// ------------------------------------------------------------------ native downloads

function friendlyNativeError(err: unknown): { error: string; code?: string } {
  if (err instanceof NativeHostError) return { error: err.message, code: err.code };
  const message = err instanceof Error ? err.message : String(err);
  if (/not found|forbidden|exited/i.test(message)) {
    invalidateNativeStatus();
    return { error: chrome.i18n.getMessage("nativeMissing"), code: "unavailable" };
  }
  return { error: message };
}

async function handleNativeProbe(payload: NativeProbePayload): Promise<NativeProbeReply> {
  if (!isSafeHttpUrl(payload.url) || (payload.referer && !isSafeHttpUrl(payload.referer))) {
    return { success: false, error: "invalid url" };
  }
  try {
    const result = await nativeProbe(payload.url, payload.referer);
    return { success: true, result };
  } catch (err) {
    return { success: false, ...friendlyNativeError(err) };
  }
}

function startNativeDownload(payload: NativeDownloadPayload, origin?: Origin): DownloadStartedReply {
  const id = generateDownloadId(payload.pageUrl || "native");
  if (origin) jobOrigins.set(id, origin);
  const now = Date.now();
  const state: DownloadState = {
    id,
    url: payload.pageUrl,
    metadata: { url: payload.pageUrl, format: VideoFormat.DIRECT, pageUrl: payload.pageUrl, title: payload.title },
    progress: { url: payload.pageUrl, stage: DownloadStage.DETECTING, percentage: 0 },
    via: "native",
    variantLabel: payload.label,
    createdAt: now,
    updatedAt: now,
  };
  const save = (mutate: (s: DownloadState) => void) => {
    mutate(state);
    state.updatedAt = Date.now();
    void storeDownload(state);
    pushProgress(state);
  };
  save(() => undefined);

  const job = nativeDownload(payload.probeId, payload.variantId, {
    onStarted: () => save((s) => (s.progress.stage = DownloadStage.DOWNLOADING)),
    onProgress: (p) =>
      save((s) => {
        s.progress.stage = p.stage === "merging" ? DownloadStage.MERGING : DownloadStage.DOWNLOADING;
        if (p.percent !== undefined) s.progress.percentage = p.percent;
        if (p.downloadedBytes !== undefined) s.progress.downloaded = p.downloadedBytes;
        if (p.totalBytes !== undefined) s.progress.total = p.totalBytes;
        if (p.speed !== undefined) s.progress.speed = p.speed;
        if (p.eta !== undefined) s.progress.eta = p.eta;
      }),
    onDone: (d) => {
      save((s) => {
        s.progress.stage = DownloadStage.COMPLETED;
        s.progress.percentage = 100;
        s.localPath = d.filepath;
      });
      nativeJobs.delete(id);
      void afterFinish(state);
      updateBadge();
    },
    onError: (err) => {
      save((s) => {
        s.progress.stage = DownloadStage.FAILED;
        s.progress.error = friendlyNativeError(err).error;
      });
      nativeJobs.delete(id);
      void afterFinish(state);
      updateBadge();
    },
  });
  nativeJobs.set(id, job);
  updateBadge();
  return { success: true, downloadId: id, via: "native" };
}

/** Big HLS/DASH stream: probe the manifest with yt-dlp and pick the same height. */
async function startNativeForStream(payload: DownloadRequestPayload, origin?: Origin): Promise<DownloadStartedReply> {
  try {
    const probe = await nativeProbe(payload.url, payload.metadata.pageUrl);
    const wanted = payload.variantHeight;
    const pick =
      (wanted && probe.variants.find((v) => v.height === wanted)) ||
      (wanted && probe.variants.find((v) => (v.height ?? 0) <= wanted)) ||
      probe.variants[0];
    if (!pick) return { success: false, error: chrome.i18n.getMessage("noVariants") };
    return startNativeDownload(
      {
        probeId: probe.probeId,
        variantId: pick.id,
        title: payload.metadata.title || probe.title,
        label: payload.variantLabel || pick.label,
        pageUrl: payload.metadata.pageUrl,
      },
      origin,
    );
  } catch (err) {
    return { success: false, ...friendlyNativeError(err) };
  }
}

// ------------------------------------------------------------------ cancel / show / list

async function cancelDownload(id: string): Promise<{ success: boolean; error?: string }> {
  const native = nativeJobs.get(id);
  if (native) {
    native.cancel();
    nativeJobs.delete(id);
    const state = await getDownload(id);
    if (state) {
      state.progress.stage = DownloadStage.CANCELLED;
      state.updatedAt = Date.now();
      await storeDownload(state);
      pushProgress(state);
    }
    updateBadge();
    return { success: true };
  }

  const state = await getDownload(id);
  if (!state) return { success: false, error: "not found" };
  if (!canCancelDownload(state.progress.stage)) return { success: false, error: CANNOT_CANCEL_MESSAGE };

  const job = browserJobs.get(id);
  job?.abort.abort();
  if (state.chromeDownloadId !== undefined) {
    await new Promise<void>((resolve) => chrome.downloads.cancel(state.chromeDownloadId!, () => resolve()));
  }
  if (state.metadata.format !== VideoFormat.DIRECT) {
    await deleteChunks(id).catch(() => undefined);
  }
  state.progress.stage = DownloadStage.CANCELLED;
  state.updatedAt = Date.now();
  await storeDownload(state);
  pushProgress(state);
  return { success: true };
}

async function showDownload(id: string): Promise<{ success: boolean }> {
  const state = await getDownload(id);
  if (state?.chromeDownloadId != null) {
    chrome.downloads.show(state.chromeDownloadId);
    return { success: true };
  }
  return { success: false };
}

async function listDownloads(): Promise<{ success: boolean; data?: DownloadState[]; error?: string }> {
  try {
    const all = await getAllDownloads();
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return { success: true, data: all.slice(0, 50) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function clearFinished(): Promise<{ success: boolean }> {
  const all = await getAllDownloads();
  const finished = [DownloadStage.COMPLETED, DownloadStage.FAILED, DownloadStage.CANCELLED];
  await Promise.all(all.filter((d) => finished.includes(d.progress.stage)).map((d) => deleteDownload(d.id)));
  return { success: true };
}

// ------------------------------------------------------------------ CORS proxy for content scripts

async function handleFetchResource(payload: {
  input: string;
  init: { method?: string; headers?: Record<string, string>; body?: number[]; mode?: RequestMode };
}): Promise<[{ body: number[]; status: number; statusText: string; headers: Record<string, string> } | null, Error | null]> {
  try {
    const { input, init } = payload;
    if (!isSafeHttpUrl(input)) throw new Error("invalid url");
    const method = (init.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error("method not allowed");
    const response = await fetch(input, {
      method,
      headers: init.headers || {},
      signal: AbortSignal.timeout(20_000),
    });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 16 * 1024 * 1024) throw new Error("response too large");
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return [
      { body: Array.from(new Uint8Array(buffer)), status: response.status, statusText: response.statusText, headers },
      null,
    ];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error))];
  }
}

// ------------------------------------------------------------------ messages

function fromExtension(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

function originOf(sender: chrome.runtime.MessageSender): Origin | undefined {
  return sender.tab?.id !== undefined ? { tabId: sender.tab.id, frameId: sender.frameId ?? 0 } : undefined;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!fromExtension(sender) || typeof message?.type !== "string") return false;
  const reply = (p: Promise<unknown>) => {
    p.then(sendResponse).catch((err) =>
      sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  };

  switch (message.type as MessageType) {
    case MessageType.CONTENT_READY: {
      const origin = originOf(sender);
      const pending = origin ? (pendingByFrame.get(frameKey(origin.tabId, origin.frameId)) ?? []) : [];
      // Answer at once: starting the native host takes seconds and must never delay detection.
      const cached = cachedNativeStatus();
      if (!cached) void nativeStatus();
      const ready: ContentReadyReply = {
        frameId: origin?.frameId ?? 0,
        pending: pending.map(({ url, formatHint }) => ({ url, ...(formatHint ? { formatHint } : {}) })),
        nativeAvailable: cached?.installed ?? false,
      };
      sendResponse(ready);
      return false;
    }
    case MessageType.FETCH_RESOURCE:
      return reply(handleFetchResource(message.payload));
    case MessageType.GET_VARIANTS:
      return reply(handleGetVariants(message.payload));
    case MessageType.DOWNLOAD_REQUEST:
      return reply(startBrowserDownload(message.payload, originOf(sender)));
    case MessageType.NATIVE_STATUS:
      return reply(nativeStatus(!!message.payload?.force));
    case MessageType.NATIVE_PROBE:
      return reply(handleNativeProbe(message.payload));
    case MessageType.NATIVE_DOWNLOAD:
      return reply(Promise.resolve(startNativeDownload(message.payload, originOf(sender))));
    case MessageType.NATIVE_UPDATE:
      return reply(
        nativeUpdate()
          .then((r) => ({ success: true, result: r }))
          .catch((err) => ({ success: false, ...friendlyNativeError(err) })),
      );
    case MessageType.CANCEL_DOWNLOAD:
      return reply(cancelDownload(String(message.payload?.id ?? "")));
    case MessageType.SHOW_DOWNLOAD:
      return reply(showDownload(String(message.payload?.id ?? "")));
    case MessageType.GET_DOWNLOADS:
      return reply(listDownloads());
    case MessageType.CLEAR_DOWNLOADS:
      return reply(clearFinished());
    case MessageType.GET_CONFIG:
      return reply(ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY).then((data) => ({ success: true, data })));
    case MessageType.SAVE_CONFIG:
      return reply(ChromeStorage.set(STORAGE_CONFIG_KEY, message.payload).then(() => ({ success: true })));
    case MessageType.OPEN_OPTIONS: {
      const section = message.payload?.section === "native" ? "#native" : "";
      return reply(chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${section}`) }).then(() => ({ success: true })));
    }
    default:
      // Offscreen responses are consumed by ffmpeg-bridge's own listener.
      return false;
  }
});

// ------------------------------------------------------------------ startup

async function cleanupStaleState(): Promise<void> {
  // Anything "in progress" from a previous worker lifetime is dead now.
  const all = await getAllDownloads();
  for (const d of all) {
    const live = [DownloadStage.DETECTING, DownloadStage.DOWNLOADING, DownloadStage.MERGING, DownloadStage.SAVING];
    if (live.includes(d.progress.stage)) {
      d.progress.stage = DownloadStage.FAILED;
      d.progress.error = chrome.i18n.getMessage("interrupted");
      await storeDownload(d);
    }
  }
  for (const downloadId of await getAllChunkDownloadIds()) {
    const d = await getDownload(downloadId);
    if (!d || d.progress.stage !== DownloadStage.DOWNLOADING) await deleteChunks(downloadId);
  }
}

chrome.runtime.onStartup.addListener(() => void cleanupStaleState().catch((e) => logger.error("cleanup", e)));
chrome.runtime.onInstalled.addListener((details) => {
  void cleanupStaleState().catch((e) => logger.error("cleanup", e));
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#welcome") });
  }
});
