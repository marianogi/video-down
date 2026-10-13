/**
 * Message types between the content scripts, the service worker, the
 * offscreen document, the popup and the options page.
 */

import type { VideoMetadata, DownloadProgress, VideoFormat } from "../core/types";
import type { BrowserVariant, ManifestQuality } from "../core/variants";
import type { ProbeResultResponse, PongResponse } from "@host/protocol";

export enum MessageType {
  // Downloads (browser engine)
  DOWNLOAD_REQUEST = "DOWNLOAD_REQUEST",
  DOWNLOAD_PROGRESS = "DOWNLOAD_PROGRESS",
  DOWNLOAD_COMPLETE = "DOWNLOAD_COMPLETE",
  DOWNLOAD_FAILED = "DOWNLOAD_FAILED",
  CANCEL_DOWNLOAD = "CANCEL_DOWNLOAD",
  SHOW_DOWNLOAD = "SHOW_DOWNLOAD",
  GET_DOWNLOADS = "GET_DOWNLOADS",
  CLEAR_DOWNLOADS = "CLEAR_DOWNLOADS",

  // Detection
  CONTENT_READY = "CONTENT_READY",
  NETWORK_URL_DETECTED = "NETWORK_URL_DETECTED",
  FRAME_MEDIA_COUNT = "FRAME_MEDIA_COUNT",
  GET_VARIANTS = "GET_VARIANTS",
  VERIFY_SNIFFED_URL = "VERIFY_SNIFFED_URL",

  // Diagnostic report (what the extension saw in a tab)
  DIAG_EVENT = "DIAG_EVENT",
  GET_DIAGNOSTICS = "GET_DIAGNOSTICS",
  OPEN_DIAGNOSTICS = "OPEN_DIAGNOSTICS",

  // Native component (yt-dlp)
  NATIVE_STATUS = "NATIVE_STATUS",
  NATIVE_PROBE = "NATIVE_PROBE",
  NATIVE_DOWNLOAD = "NATIVE_DOWNLOAD",
  NATIVE_UPDATE = "NATIVE_UPDATE",

  // Config
  GET_CONFIG = "GET_CONFIG",
  SAVE_CONFIG = "SAVE_CONFIG",
  OPEN_OPTIONS = "OPEN_OPTIONS",

  // Fetch resource (for CORS bypass in content scripts)
  FETCH_RESOURCE = "FETCH_RESOURCE",

  // Offscreen messages
  OFFSCREEN_PROCESS_HLS = "OFFSCREEN_PROCESS_HLS",
  OFFSCREEN_PROCESS_HLS_RESPONSE = "OFFSCREEN_PROCESS_HLS_RESPONSE",
  OFFSCREEN_PROCESS_M3U8 = "OFFSCREEN_PROCESS_M3U8",
  OFFSCREEN_PROCESS_M3U8_RESPONSE = "OFFSCREEN_PROCESS_M3U8_RESPONSE",
  OFFSCREEN_PROCESS_DASH = "OFFSCREEN_PROCESS_DASH",
  OFFSCREEN_PROCESS_DASH_RESPONSE = "OFFSCREEN_PROCESS_DASH_RESPONSE",

  // Blob URL revocation (must be sent to offscreen document — not service worker)
  REVOKE_BLOB_URL = "REVOKE_BLOB_URL",

  // FFmpeg pre-warm
  WARMUP_FFMPEG = "WARMUP_FFMPEG",
}

export interface BaseMessage {
  type: MessageType;
  payload?: any;
}

// ---------------------------------------------------------------- payloads

export interface DownloadRequestPayload {
  url: string;
  metadata: VideoMetadata;
  filename?: string;
  tabTitle?: string;
  website?: string;
  manifestQuality?: ManifestQuality;
  /** Label shown in the UI for the chosen quality */
  variantLabel?: string;
  /** Height of the chosen quality, used if the download is handed to yt-dlp */
  variantHeight?: number;
  /** Estimated size; above the configured limit the native component takes over */
  approxBytes?: number;
}

export interface DownloadStartedReply {
  success: boolean;
  downloadId?: string;
  via?: "browser" | "native";
  error?: string;
}

export interface GetVariantsPayload {
  url: string;
  format: VideoFormat;
  duration?: number;
  /** The playlist as the page's player received it, when the content script has it */
  text?: string;
}

export interface GetVariantsReply {
  success: boolean;
  variants?: BrowserVariant[];
  error?: string;
}

export interface NativeStatusReply {
  installed: boolean;
  pong?: PongResponse;
  error?: string;
}

export interface NativeProbePayload {
  url: string;
  referer?: string;
}

export interface NativeProbeReply {
  success: boolean;
  result?: ProbeResultResponse;
  error?: string;
  code?: string;
}

export interface NativeDownloadPayload {
  probeId: string;
  variantId: string;
  title: string;
  label: string;
  pageUrl: string;
}

export interface ProgressPush {
  id: string;
  progress: DownloadProgress;
  via?: "browser" | "native";
  label?: string;
  filePath?: string;
}

export interface ContentReadyReply {
  frameId: number;
  pending: Array<{ url: string; formatHint?: VideoFormat }>;
  nativeAvailable: boolean;
}
