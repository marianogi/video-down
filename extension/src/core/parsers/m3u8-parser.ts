/**
 * M3U8 playlist parser utility
 */

import { Parser } from "m3u8-parser";
import { buildAbsoluteURL } from "url-toolkit";
import { Level, LevelType } from "../types";
import type { ByteRange, ParsedPlaylist, ParsedSegment } from "./playlist-utils";
import { normalizeUrl } from "../utils/url-utils";
import { logger } from "../utils/logger";

export { parseLevelsPlaylist } from "./playlist-utils";
import { parseLevelsPlaylist } from "./playlist-utils";

/**
 * Parse a media playlist into a ParsedPlaylist (protocol-agnostic intermediate).
 * Pass the result to parseLevelsPlaylist() to get Fragment[].
 */
/**
 * m3u8-parser returns an explicit IV as a Uint32Array of four 32-bit words.
 * Each word must be written as 8 hex digits (Media Bridge padded to 2, which
 * corrupted every IV with a word that starts with zero bytes).
 */
export function ivToHex(iv: ArrayLike<number>): string {
  return Array.from(iv)
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/**
 * RFC 8216 §5.2: when EXT-X-KEY has no IV attribute, the IV is the segment's
 * Media Sequence Number as a 128-bit big-endian integer.
 */
export function ivFromSequence(sequence: number): string {
  return BigInt(sequence).toString(16).padStart(32, "0");
}

function toRange(r: { offset?: number | bigint; length?: number | bigint } | undefined): ByteRange | undefined {
  if (!r || r.length === undefined) return undefined;
  return { offset: Number(r.offset ?? 0), length: Number(r.length) };
}

export function parseMediaPlaylist(playlistText: string, baseUrl: string): ParsedPlaylist {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const firstSequence = Number(parser.manifest.mediaSequence ?? 0);

  const segments: ParsedSegment[] = (parser.manifest.segments || []).map((segment, i) => {
    const ps: ParsedSegment = { uri: buildAbsoluteURL(baseUrl, segment.uri) };
    const range = toRange(segment.byterange);
    if (range) ps.byteRange = range;

    if (segment.map?.uri) {
      ps.initUri = buildAbsoluteURL(baseUrl, segment.map.uri);
      const initRange = toRange(segment.map.byterange);
      if (initRange) ps.initByteRange = initRange;
      // An encrypted init segment must carry its own explicit IV (RFC 8216 §4.3.2.5).
      const mapKey = (segment.map as { key?: { method?: string; uri?: string; iv?: Uint32Array } }).key;
      if (mapKey?.uri && mapKey.iv && (mapKey.method ?? "AES-128") === "AES-128") {
        ps.initKey = { uri: buildAbsoluteURL(baseUrl, mapKey.uri), iv: ivToHex(mapKey.iv) };
      }
    }

    // Only AES-128 is decrypted here; SAMPLE-AES and friends are DRM and never reach a download.
    if (segment.key?.uri && (segment.key.method ?? "AES-128") === "AES-128") {
      ps.key = {
        uri: buildAbsoluteURL(baseUrl, segment.key.uri),
        iv: segment.key.iv ? ivToHex(segment.key.iv) : ivFromSequence(firstSequence + i),
      };
    }

    return ps;
  });

  return { segments };
}

/**
 * Parse a master playlist into levels (variants/qualities)
 */
export function parseMasterPlaylist(
  playlistText: string,
  baseUrl: string,
): Level[] {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const playlists = parser.manifest?.playlists || [];
  const audioPlaylists = parser.manifest?.mediaGroups?.AUDIO || {};

  // Parse video stream playlists
  const streamLevels: Level[] = playlists.map((playlist) => ({
    type: "stream" as LevelType,
    id: crypto.randomUUID(),
    playlistID: baseUrl,
    uri: buildAbsoluteURL(baseUrl, playlist.uri),
    bitrate: playlist.attributes.BANDWIDTH,
    fps: playlist.attributes["FRAME-RATE"],
    height: playlist.attributes.RESOLUTION?.height,
    width: playlist.attributes.RESOLUTION?.width,
  }));

  // Parse audio playlists
  const audioLevels: Level[] = Object.entries(audioPlaylists).flatMap(
    ([key, entries]) => {
      return Object.entries(entries).map(([label, entry]: [string, any]) => {
        return {
          type: "audio" as LevelType,
          id: `${label}-${key}`,
          playlistID: baseUrl,
          uri: buildAbsoluteURL(baseUrl, entry.uri),
          bitrate: undefined,
          fps: undefined,
          width: undefined,
          height: undefined,
        };
      });
    },
  );

  return [...streamLevels, ...audioLevels];
}

/**
 * Check if a playlist is a master playlist (contains variants)
 */
export function isMasterPlaylist(playlistText: string): boolean {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  // Master playlists have playlists array or mediaGroups
  return (
    (parser.manifest.playlists && parser.manifest.playlists.length > 0) ||
    (parser.manifest.mediaGroups &&
      Object.keys(parser.manifest.mediaGroups).length > 0) ||
    false
  );
}

/**
 * Check if a playlist is a media playlist (contains direct segments)
 */
export function isMediaPlaylist(playlistText: string): boolean {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  // Media playlists have segments array with actual segment URIs
  // They don't have playlists or mediaGroups (those are master playlists)
  const hasSegments =
    parser.manifest.segments && parser.manifest.segments.length > 0;
  const hasNoPlaylists =
    !parser.manifest.playlists || parser.manifest.playlists.length === 0;
  const hasNoMediaGroups =
    !parser.manifest.mediaGroups ||
    Object.keys(parser.manifest.mediaGroups).length === 0;

  return hasSegments && hasNoPlaylists && hasNoMediaGroups;
}

/**
 * Check if a media playlist belongs to a specific master playlist
 *
 * This function determines membership by comparing URLs:
 * 1. Parses the master playlist to extract all variant URIs
 * 2. Resolves variant URIs into full URLs (relative to master playlist base URL)
 * 3. Compares the media playlist URL against all variant URLs
 * 4. Returns true if there's a match
 *
 * @param masterPlaylistText - The master playlist content as text
 * @param masterPlaylistBaseUrl - The base URL of the master playlist (used to resolve relative URIs)
 * @param mediaPlaylistUrl - The URL of the media playlist to check
 * @returns true if the media playlist belongs to the master playlist, false otherwise
 */
export function belongsToMasterPlaylist(
  masterPlaylistText: string,
  masterPlaylistBaseUrl: string,
  mediaPlaylistUrl: string,
): boolean {
  // Parse the master playlist to get all variant levels
  const levels = parseMasterPlaylist(masterPlaylistText, masterPlaylistBaseUrl);

  // Normalize the media playlist URL for comparison
  const normalizedMediaUrl = normalizeUrl(mediaPlaylistUrl);

  logger.debug("Normalized media URL", { normalizedMediaUrl });
  logger.debug("levels", { levels });

  // Check if the media playlist URL matches any variant URL from the master playlist
  return levels.some((level) => {
    const normalizedVariantUrl = normalizeUrl(level.uri);
    return normalizedVariantUrl === normalizedMediaUrl;
  });
}

export const M3u8Parser = {
  parseLevelsPlaylist,
  parseMediaPlaylist,
  parseMasterPlaylist,
  isMasterPlaylist,
  isMediaPlaylist,
  belongsToMasterPlaylist,
};
