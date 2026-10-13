/**
 * Resolved application settings.
 *
 * Always import settings via `loadSettings()` — never read StorageConfig directly.
 * Every field here has a concrete type with defaults applied, so consumers never
 * need null-checks or scattered `?? DEFAULT_X` fallbacks.
 */

import { StorageConfig } from "../types";
import { ChromeStorage } from "./chrome-storage";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_FFMPEG_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  INITIAL_RETRY_DELAY_MS,
  RETRY_BACKOFF_FACTOR,
  MAX_FRAGMENT_FAILURE_RATE,
  DEFAULT_MIN_POLL_MS,
  DEFAULT_MAX_POLL_MS,
  DEFAULT_POLL_FRACTION,
  DEFAULT_DETECTION_CACHE_SIZE,
  DEFAULT_MASTER_PLAYLIST_CACHE_SIZE,
  DEFAULT_DB_SYNC_INTERVAL_MS,
  DEFAULT_MIN_VIDEO_WIDTH,
  DEFAULT_PREFER_NATIVE_ABOVE_MB,
  STORAGE_CONFIG_KEY,
} from "../../shared/constants";

export interface AppSettings {
  ffmpegTimeout: number;
  maxConcurrent: number;
  historyEnabled: boolean;
  askWhereToSave: boolean;
  showOverlay: boolean;
  minVideoWidth: number;
  preferNativeAboveMb: number;
  useSiteSession: boolean;
  useSiteSessionOnYoutube: boolean;

  recording: {
    minPollIntervalMs: number;
    maxPollIntervalMs: number;
    pollFraction: number;
  };

  notifications: {
    notifyOnCompletion: boolean;
    autoOpenFile: boolean;
  };

  advanced: {
    maxRetries: number;
    retryDelayMs: number;
    retryBackoffFactor: number;
    fragmentFailureRate: number;
    detectionCacheSize: number;
    masterPlaylistCacheSize: number;
    dbSyncIntervalMs: number;
  };
}

/** Apply defaults to a raw stored config. Pure, so it can be unit-tested. */
export function resolveSettings(raw: StorageConfig | null | undefined): AppSettings {
  return {
    ffmpegTimeout: raw?.ffmpegTimeout ?? DEFAULT_FFMPEG_TIMEOUT_MS,
    maxConcurrent: raw?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    historyEnabled: raw?.historyEnabled ?? true,
    askWhereToSave: raw?.askWhereToSave ?? false,
    showOverlay: raw?.showOverlay ?? true,
    minVideoWidth: raw?.minVideoWidth ?? DEFAULT_MIN_VIDEO_WIDTH,
    preferNativeAboveMb: raw?.preferNativeAboveMb ?? DEFAULT_PREFER_NATIVE_ABOVE_MB,
    useSiteSession: raw?.useSiteSession ?? true,
    useSiteSessionOnYoutube: raw?.useSiteSessionOnYoutube ?? false,

    recording: {
      minPollIntervalMs: raw?.recording?.minPollIntervalMs ?? DEFAULT_MIN_POLL_MS,
      maxPollIntervalMs: raw?.recording?.maxPollIntervalMs ?? DEFAULT_MAX_POLL_MS,
      pollFraction: raw?.recording?.pollFraction ?? DEFAULT_POLL_FRACTION,
    },

    notifications: {
      notifyOnCompletion: raw?.notifications?.notifyOnCompletion ?? false,
      autoOpenFile: raw?.notifications?.autoOpenFile ?? false,
    },

    advanced: {
      maxRetries: raw?.advanced?.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelayMs: raw?.advanced?.retryDelayMs ?? INITIAL_RETRY_DELAY_MS,
      retryBackoffFactor: raw?.advanced?.retryBackoffFactor ?? RETRY_BACKOFF_FACTOR,
      fragmentFailureRate: raw?.advanced?.fragmentFailureRate ?? MAX_FRAGMENT_FAILURE_RATE,
      detectionCacheSize: raw?.advanced?.detectionCacheSize ?? DEFAULT_DETECTION_CACHE_SIZE,
      masterPlaylistCacheSize:
        raw?.advanced?.masterPlaylistCacheSize ?? DEFAULT_MASTER_PLAYLIST_CACHE_SIZE,
      dbSyncIntervalMs: raw?.advanced?.dbSyncIntervalMs ?? DEFAULT_DB_SYNC_INTERVAL_MS,
    },
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const raw = await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY);
  return resolveSettings(raw);
}

/** Whether Chrome should show its "Save as" dialog for each download. */
export async function shouldAskWhereToSave(): Promise<boolean> {
  try {
    return (await loadSettings()).askWhereToSave;
  } catch {
    return false;
  }
}
