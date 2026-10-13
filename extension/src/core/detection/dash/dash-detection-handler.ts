/**
 * DASH detection handler
 *
 * Detects MPEG-DASH streams from network requests by recognizing .mpd URLs,
 * fetching the manifest, and extracting metadata including DRM status and
 * live/VOD distinction.
 *
 * Mirrors HlsDetectionHandler in structure and deduplication strategy.
 */

import { VideoMetadata, VideoFormat } from "../../types";
import { fetchText } from "../../utils/fetch-utils";
import { normalizeUrl } from "../../utils/url-utils";
import { logger } from "../../utils/logger";
import { extractThumbnail } from "../thumbnail-utils";
import { isLive } from "../../parsers/mpd-parser";
import { detectDashDrm } from "../../utils/drm-utils";
import { type DetectionFailure, describeBody, redactUrl, statusFromError } from "../detection-failure";
import { DEFAULT_DETECTION_CACHE_SIZE } from "../../../shared/constants";
import type { PlaylistBodies } from "../playlist-bodies";

export interface DashDetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
  /** Called when a manifest seen on the network cannot be read */
  onDetectionFailed?: (failure: DetectionFailure) => void;
  /** Max distinct URL path keys tracked per page (default: 500) */
  detectionCacheSize?: number;
  /** Manifests as the page's player received them (used when they cannot be read again) */
  bodies?: PlaylistBodies;
}

/**
 * DASH detection handler — detects .mpd manifest URLs
 */
export class DashDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onDetectionFailed?: (failure: DetectionFailure) => void;
  private seenPathKeys: Set<string> = new Set();
  private readonly maxSeenPathKeys: number;
  private readonly bodies?: PlaylistBodies;

  constructor(options: DashDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.onDetectionFailed = options.onDetectionFailed;
    this.bodies = options.bodies;
    this.maxSeenPathKeys = options.detectionCacheSize ?? DEFAULT_DETECTION_CACHE_SIZE;
  }

  destroy(): void {
    this.seenPathKeys.clear();
  }

  /** Let a manifest be detected again (the page moved on and may come back to it). */
  forget(url: string): void {
    this.seenPathKeys.delete(this.getPathKey(url));
  }

  private async fetchManifestText(url: string): Promise<string> {
    const known = this.bodies?.get(url);
    if (known !== undefined) return known;
    try {
      return await fetchText(url, 1);
    } catch (error) {
      const late = this.bodies?.get(url);
      if (late !== undefined) return late;
      throw error;
    }
  }

  handleNetworkRequest(url: string, force: boolean = false): void {
    if (force || this.isDashUrl(url)) {
      this.detect(url, force);
    }
  }

  async detect(url: string, force: boolean = false): Promise<VideoMetadata | null> {
    if (!force && !this.isDashUrl(url)) return null;

    // Deduplicate by origin+pathname — ignores auth tokens in query params
    const pathKey = this.getPathKey(url);
    if (this.seenPathKeys.has(pathKey)) return null;
    if (this.seenPathKeys.size >= this.maxSeenPathKeys) {
      const first = this.seenPathKeys.values().next().value;
      if (first) this.seenPathKeys.delete(first);
    }
    this.seenPathKeys.add(pathKey);

    try {
      const mpdText = await this.fetchManifestText(url);
      if (!/<(?:\w+:)?MPD[\s>]/i.test(mpdText.slice(0, 4096))) {
        this.seenPathKeys.delete(pathKey);
        const body = describeBody(mpdText);
        logger.debug(`[video-down] Not a DASH manifest (${body}): ${redactUrl(url)}`);
        this.onDetectionFailed?.({ url, format: VideoFormat.DASH, reason: "not-playlist", body, at: Date.now() });
        return null;
      }
      const metadata = this.extractMetadata(url, mpdText);
      if (metadata && this.onVideoDetected) {
        this.onVideoDetected(metadata);
      }
      return metadata;
    } catch (error) {
      this.seenPathKeys.delete(pathKey);
      const status = statusFromError(error);
      logger.debug(`[video-down] Could not read DASH manifest ${redactUrl(url)}: ${status ?? String(error)}`);
      this.onDetectionFailed?.({
        url,
        format: VideoFormat.DASH,
        reason: status ? "http" : "network",
        ...(status ? { status } : {}),
        at: Date.now(),
      });
      return null;
    }
  }

  private isDashUrl(url: string): boolean {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      return pathname.endsWith(".mpd");
    } catch {
      return url.toLowerCase().includes(".mpd");
    }
  }

  private getPathKey(url: string): string {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  private extractMetadata(url: string, mpdText: string): VideoMetadata {
    const drmSystem = detectDashDrm(mpdText);
    const drm = drmSystem !== null;
    const live = isLive(mpdText);

    const metadata: VideoMetadata = {
      url,
      format: VideoFormat.DASH,
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "mpd",
      hasDrm: drm,
      unsupported: drm, // DRM-protected DASH cannot be downloaded
      isLive: live,
      ...(drmSystem ? { drmSystem } : {}),
    };

    const thumbnail = extractThumbnail();
    if (thumbnail) metadata.thumbnail = thumbnail;

    return metadata;
  }

  /** Check whether a Content-Type header indicates a DASH manifest */
  isDashContentType(contentType: string): boolean {
    return contentType.toLowerCase().includes("application/dash+xml");
  }

  /** Normalize URL for deduplication — removes hash fragment */
  normalizeUrl(url: string): string {
    return normalizeUrl(url);
  }
}
