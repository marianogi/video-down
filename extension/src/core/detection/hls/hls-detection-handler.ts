/**
 * HLS detection handler - orchestrates HLS playlist detection
 *
 * This handler is responsible for detecting HLS (HTTP Live Streaming) playlists from network requests.
 * It distinguishes between master playlists (containing multiple quality variants) and media playlists
 * (containing actual video fragments), and manages the relationship between them.
 *
 * Key features:
 * - Detects HLS master playlists and media playlists from network requests
 * - Distinguishes between master and media playlists
 * - Tracks master playlists and their variant URLs
 * - Removes media playlists that belong to master playlists (to avoid duplicates)
 * - Extracts metadata from playlist URLs
 * - Handles both HLS format (master playlists) and M3U8 format (standalone media playlists)
 *
 * Detection process:
 * 1. Network requests are intercepted and checked for .m3u8 URLs
 * 2. Playlist content is fetched and analyzed to determine type (master vs media)
 * 3. Master playlists are tracked with their variant URLs
 * 4. Media playlists are checked if they belong to tracked master playlists
 * 5. Standalone media playlists are detected as M3U8 format
 * 6. Master playlists are detected as HLS format
 * 7. Variant videos are removed when master playlist is detected
 *
 * @module HlsDetectionHandler
 */

import { VideoMetadata, VideoFormat } from "../../types";
import {
  isMasterPlaylist,
  isMediaPlaylist,
  parseMasterPlaylist,
} from "../../parsers/m3u8-parser";
import { fetchText } from "../../utils/fetch-utils";
import { normalizeUrl } from "../../utils/url-utils";
import { masterCandidates, withInheritedQuery } from "../../parsers/master-discovery";
import type { PlaylistBodies } from "../playlist-bodies";
import { logger } from "../../utils/logger";
import { extractThumbnail } from "../thumbnail-utils";
import { detectHlsDrm, canDecrypt } from "../../utils/drm-utils";
import { DEFAULT_DETECTION_CACHE_SIZE, DEFAULT_MASTER_PLAYLIST_CACHE_SIZE } from "../../../shared/constants";
import { type DetectionFailure, describeBody, errorDetail, redactUrl, statusFromError } from "../detection-failure";

/** Configuration options for HlsDetectionHandler */
export interface HlsDetectionHandlerOptions {
  /** Optional callback for detected videos */
  onVideoDetected?: (video: VideoMetadata) => void;
  /** Optional callback for removed videos */
  onVideoRemoved?: (url: string) => void;
  /** Called when a manifest seen on the network cannot be read */
  onDetectionFailed?: (failure: DetectionFailure) => void;
  /** Max distinct URL path keys tracked per page (default: 500) */
  detectionCacheSize?: number;
  /** Max master playlists held in memory (default: 50) */
  masterPlaylistCacheSize?: number;
  /** Playlists as the page's player received them (used when they cannot be read again) */
  bodies?: PlaylistBodies;
  /** Notes for the diagnostic report */
  onDiagnostic?: (event: string, url: string, detail?: string) => void;
}

/** Internal structure for tracking master playlist information */
interface MasterPlaylistInfo {
  url: string;
  variantUrls: Set<string>;
  variantPathKeys: Set<string>;
}

/**
 * HLS detection handler
 * Detects HLS master playlists and standalone media playlists
 */
export class HlsDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onVideoRemoved?: (url: string) => void;
  private onDetectionFailed?: (failure: DetectionFailure) => void;
  private onDiagnostic?: (event: string, url: string, detail?: string) => void;
  private readonly bodies?: PlaylistBodies;
  // Variant playlists whose master was already looked for (see discoverMaster)
  private readonly discoveryTried: Set<string> = new Set();
  // Track master playlists and their variants
  private masterPlaylists: Map<string, MasterPlaylistInfo> = new Map();
  // Deduplicate HLS URLs by origin+pathname (ignoring query params like tokens/timestamps)
  private seenPathKeys: Set<string> = new Set();
  private readonly maxSeenPathKeys: number;
  private readonly maxMasterPlaylists: number;

  /**
   * Create a new HlsDetectionHandler instance
   * @param options - Configuration options
   */
  constructor(options: HlsDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.onVideoRemoved = options.onVideoRemoved;
    this.onDetectionFailed = options.onDetectionFailed;
    this.onDiagnostic = options.onDiagnostic;
    this.bodies = options.bodies;
    this.maxSeenPathKeys = options.detectionCacheSize ?? DEFAULT_DETECTION_CACHE_SIZE;
    this.maxMasterPlaylists = options.masterPlaylistCacheSize ?? DEFAULT_MASTER_PLAYLIST_CACHE_SIZE;
  }

  /**
   * Clean up all resources to prevent memory leaks
   */
  destroy(): void {
    this.seenPathKeys.clear();
    this.masterPlaylists.clear();
    this.discoveryTried.clear();
  }

  /** Let a playlist be detected again (the page moved on and may come back to it). */
  forget(url: string): void {
    const key = this.getPathKey(url);
    this.seenPathKeys.delete(key);
    this.discoveryTried.delete(key);
    this.masterPlaylists.delete(normalizeUrl(url));
  }

  /**
   * Detect HLS playlist from URL
   * @param url - Playlist URL to detect
   * @returns Promise resolving to VideoMetadata or null if not detected
   */
  async detect(url: string, force: boolean = false): Promise<VideoMetadata | null> {
    // `force` is used when the manifest was recognised by its Content-Type
    // even though the URL has no .m3u8 extension.
    if (!force && !this.isHlsUrl(url)) {
      return null;
    }

    // Deduplicate by origin+pathname so re-fetches with different query params
    // (auth tokens, timestamps) don't create duplicate video cards
    const pathKey = this.getPathKey(url);
    if (this.seenPathKeys.has(pathKey)) {
      return null;
    }
    // Evict oldest entries if over limit
    if (this.seenPathKeys.size >= this.maxSeenPathKeys) {
      const first = this.seenPathKeys.values().next().value;
      if (first) this.seenPathKeys.delete(first);
    }
    this.seenPathKeys.add(pathKey);

    let playlistText: string;
    try {
      playlistText = await this.fetchPlaylistText(url);
    } catch (error) {
      this.seenPathKeys.delete(pathKey);
      const status = statusFromError(error);
      logger.debug(`[video-down] Could not read HLS playlist ${redactUrl(url)}: ${status ?? String(error)}`);
      this.onDetectionFailed?.({
        url,
        format: VideoFormat.HLS,
        reason: status ? "http" : "network",
        ...(status ? { status } : {}),
        at: Date.now(),
      });
      return null;
    }

    // Read fine but not understood: reported as such (it used to look like a network error).
    try {
      const normalizedUrl = normalizeUrl(url);
      const isMaster = isMasterPlaylist(playlistText);
      const isMedia = isMediaPlaylist(playlistText);

      if (isMedia) {
        return await this.handleMediaPlaylist(url, normalizedUrl, playlistText);
      }

      if (isMaster) {
        return await this.handleMasterPlaylist(
          url,
          normalizedUrl,
          playlistText,
        );
      }

      // Not a standard playlist (error page, JSON, or a format/encryption of the platform's own).
      // Forget the key so a later request (fresh token, after pressing play) is tried again.
      this.seenPathKeys.delete(pathKey);
      const body = describeBody(playlistText);
      logger.debug(`[video-down] Not an HLS playlist (${body}): ${redactUrl(url)}`);
      this.onDetectionFailed?.({ url, format: VideoFormat.HLS, reason: "not-playlist", body, at: Date.now() });
      return null;
    } catch (error) {
      this.seenPathKeys.delete(pathKey);
      const detail = errorDetail(error);
      logger.debug(`[video-down] Could not understand HLS playlist ${redactUrl(url)}: ${detail}`);
      this.onDetectionFailed?.({ url, format: VideoFormat.HLS, reason: "parse", detail, at: Date.now() });
      return null;
    }
  }

  /**
   * Fetch playlist text from URL
   * @private
   */
  private async fetchPlaylistText(url: string): Promise<string> {
    const known = this.bodies?.get(url);
    if (known !== undefined) return known;
    try {
      return await fetchText(url, 1);
    } catch (error) {
      // The player's own copy may have arrived meanwhile (single-use or short-lived links).
      const late = this.bodies?.get(url);
      if (late !== undefined) return late;
      throw error;
    }
  }

  /**
   * Handle media playlist detection
   * @private
   */
  private async handleMediaPlaylist(
    url: string,
    normalizedUrl: string,
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    const belongsToMaster = this.checkIfBelongsToMasterPlaylist(normalizedUrl);

    if (belongsToMaster) {
      logger.debug(
        "[video-down] M3U8 media playlist belongs to a master playlist, removing it",
        url,
      );
      this.onDiagnostic?.("variant-of-master", url);
      this.removeDetectedVideo(normalizedUrl);
      return null;
    }

    // It's a standalone media playlist, add it as M3U8 format
    // A media playlist without #EXT-X-ENDLIST is a live stream
    const isLive = !playlistText.includes("#EXT-X-ENDLIST");
    logger.debug(`[video-down] HLS media playlist: ${redactUrl(url)}`);
    const metadata = await this.addDetectedVideo(url, VideoFormat.M3U8, playlistText, isLive);
    void this.discoverMaster(url);
    return metadata;
  }

  /**
   * Only a variant playlist was seen, so only one quality could be offered. Look for its master
   * where widespread packagers put it (see master-discovery.ts). A candidate counts only if it
   * is a master that lists this very playlist; misses are silent, since they are guesses and
   * not something the page did wrong.
   */
  private async discoverMaster(mediaUrl: string): Promise<void> {
    const mediaKey = this.getPathKey(mediaUrl);
    if (this.discoveryTried.has(mediaKey)) return;
    this.discoveryTried.add(mediaKey);
    let tried = 0;
    for (const candidate of masterCandidates(mediaUrl)) {
      const candidateKey = this.getPathKey(candidate);
      if (this.seenPathKeys.has(candidateKey)) continue;
      tried++;
      let text: string;
      try {
        text = await fetchText(candidate, 1);
      } catch {
        continue;
      }
      // The real master may have been detected while we were guessing.
      if (this.checkIfBelongsToMasterPlaylist(normalizeUrl(mediaUrl))) return;
      if (!isMasterPlaylist(text)) continue;
      const lists = parseMasterPlaylist(text, candidate).some((l) => this.getPathKey(l.uri) === mediaKey);
      if (!lists) continue;
      const adjusted = withInheritedQuery(text, mediaUrl);
      this.seenPathKeys.add(candidateKey);
      this.bodies?.set(candidate, adjusted);
      this.onDiagnostic?.("master-found", candidate, `next to ${redactUrl(mediaUrl)}`);
      await this.handleMasterPlaylist(candidate, normalizeUrl(candidate), adjusted);
      return;
    }
    this.onDiagnostic?.("master-not-found", mediaUrl, `${tried} candidate(s) tried`);
  }

  /**
   * Handle master playlist detection
   * @private
   */
  private async handleMasterPlaylist(
    url: string,
    normalizedUrl: string,
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    logger.debug(`[video-down] HLS master playlist: ${redactUrl(url)}`);

    // Parse once, reuse for tracking and liveness check
    const levels = parseMasterPlaylist(playlistText, url);
    this.onDiagnostic?.("master", url, `${levels.filter((l) => l.type === "stream").length} variant(s)`);

    const variantUrls = this.trackMasterPlaylistWithLevels(
      url,
      normalizedUrl,
      levels,
    );

    // Remove any existing detected videos that are variants of this master playlist
    this.removeVariantVideos(variantUrls);

    // Determine liveness by fetching the first variant playlist and checking for #EXT-X-ENDLIST
    // Keys usually live in the variant playlists, not in the master, so the
    // first variant is inspected for liveness *and* for DRM markers.
    const probe = await this.probeFirstVariant(levels);

    return await this.addDetectedVideo(
      url,
      VideoFormat.HLS,
      probe.variantText ? `${playlistText}\n${probe.variantText}` : playlistText,
      probe.isLive,
    );
  }

  /**
   * Check if an HLS master playlist represents a live stream
   * Fetches the first video variant and checks for #EXT-X-ENDLIST
   * @private
   */
  private async probeFirstVariant(
    levels: ReturnType<typeof parseMasterPlaylist>,
  ): Promise<{ isLive: boolean; variantText: string | null }> {
    try {
      const firstVariant = levels.find((l) => l.type === "stream");
      if (!firstVariant) return { isLive: false, variantText: null };
      const variantText = this.bodies?.get(firstVariant.uri) ?? (await fetchText(firstVariant.uri, 1));
      return { isLive: !variantText.includes("#EXT-X-ENDLIST"), variantText };
    } catch {
      // If we can't fetch the variant, assume VOD (safer default)
      return { isLive: false, variantText: null };
    }
  }

  /**
   * Track master playlist and extract variant URLs
   * @private
   */
  private trackMasterPlaylistWithLevels(
    url: string,
    normalizedUrl: string,
    levels: ReturnType<typeof parseMasterPlaylist>,
  ): Set<string> {
    const variantUrls = new Set<string>();
    const variantPathKeys = new Set<string>();

    levels.forEach((level) => {
      const normalizedVariantUrl = normalizeUrl(level.uri);
      variantUrls.add(normalizedVariantUrl);
      variantPathKeys.add(this.getPathKey(normalizedVariantUrl));
    });

    // Evict oldest master playlists if over limit
    if (this.masterPlaylists.size >= this.maxMasterPlaylists) {
      const firstKey = this.masterPlaylists.keys().next().value;
      if (firstKey) this.masterPlaylists.delete(firstKey);
    }

    this.masterPlaylists.set(normalizedUrl, {
      url,
      variantUrls,
      variantPathKeys,
    });

    return variantUrls;
  }

  /**
   * Remove detected video if callback is available
   * @private
   */
  private removeDetectedVideo(normalizedUrl: string): void {
    if (this.onVideoRemoved) {
      this.onVideoRemoved(normalizedUrl);
    }
  }

  /**
   * Extract metadata and notify about detected video
   * @private
   */
  private async addDetectedVideo(
    url: string,
    format: VideoFormat.HLS | VideoFormat.M3U8,
    playlistText: string,
    isLive: boolean = false,
  ): Promise<VideoMetadata | null> {
    const metadata = await this.extractMetadata(url, format, playlistText, isLive);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for HLS playlist
   * Triggers detection for HLS URLs
   */
  handleNetworkRequest(url: string, force: boolean = false): void {
    if (force || this.isHlsUrl(url)) {
      this.detect(url, force);
    }
  }

  /**
   * Check if URL is an HLS playlist URL
   * @private
   */
  private isHlsUrl(url: string): boolean {
    const urlLower = url.toLowerCase();
    return urlLower.includes(".m3u8") || !!urlLower.match(/\.m3u8(\?|$|#)/);
  }

  /**
   * Check if content type indicates HLS playlist
   * @param contentType - Content-Type header value
   * @returns True if content type indicates HLS playlist
   */
  /**
   * Get a deduplication key from a URL using only origin + pathname.
   * This ensures that the same playlist re-fetched with different query
   * parameters (tokens, timestamps) is recognized as the same stream.
   */
  private getPathKey(url: string): string {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  isHlsContentType(contentType: string): boolean {
    const contentTypeLower = contentType.toLowerCase();
    return (
      contentTypeLower.includes("application/vnd.apple.mpegurl") ||
      contentTypeLower.includes("application/x-mpegurl")
    );
  }

  /**
   * Check if a media playlist URL belongs to any tracked master playlist
   * @private
   */
  private checkIfBelongsToMasterPlaylist(mediaPlaylistUrl: string): boolean {
    const mediaPathKey = this.getPathKey(mediaPlaylistUrl);
    for (const masterInfo of this.masterPlaylists.values()) {
      // O(1) exact URL match
      if (masterInfo.variantUrls.has(mediaPlaylistUrl)) {
        return true;
      }
      // O(1) path key match (handles different query params)
      if (masterInfo.variantPathKeys.has(mediaPathKey)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Remove variant videos that belong to master playlists
   * @private
   */
  private removeVariantVideos(variantUrls: Set<string>): void {
    if (!this.onVideoRemoved) {
      return;
    }

    const onVideoRemoved = this.onVideoRemoved;
    variantUrls.forEach((variantUrl) => {
      logger.debug(
        "[video-down] Removing variant video that belongs to master playlist",
        { variantUrl },
      );
      onVideoRemoved(variantUrl);
    });
  }

  /**
   * Extract metadata from HLS playlist URL
   * @private
   */
  private async extractMetadata(
    url: string,
    format: VideoFormat.HLS | VideoFormat.M3U8 = VideoFormat.HLS,
    playlistText: string,
    isLive: boolean = false,
  ): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format,
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "m3u8",
      hasDrm: false,
      unsupported: !canDecrypt(playlistText),
      isLive,
    };
    const drmSystem = detectHlsDrm(playlistText);
    if (drmSystem) {
      metadata.hasDrm = true;
      metadata.drmSystem = drmSystem;
    }

    // Extract thumbnail using unified utility (page-based search)
    const thumbnail = extractThumbnail();
    if (thumbnail) {
      metadata.thumbnail = thumbnail;
    }

    return metadata;
  }
}
