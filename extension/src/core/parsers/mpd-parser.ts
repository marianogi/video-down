/**
 * MPD (MPEG-DASH) manifest parser utility
 *
 * Wraps the `mpd-parser` npm package and converts its output to the
 * project's Fragment[] and Level[] types. Mirrors the structure of m3u8-parser.ts.
 */

import { parse, MpdManifest, MpdPlaylist } from "mpd-parser";
import { Level, LevelType } from "../types";
import type { ParsedPlaylist, ParsedSegment } from "./playlist-utils";
import { parseLevelsPlaylist } from "./playlist-utils";
import { detectDashDrm } from "../utils/drm-utils";

// Re-export for callers that want the unified Fragment conversion.
export { parseLevelsPlaylist } from "./playlist-utils";

export type { MpdManifest } from "mpd-parser";

/**
 * Convert an mpd-parser MpdPlaylist into a ParsedPlaylist.
 */
function mpdPlaylistToParsedPlaylist(playlist: MpdPlaylist): ParsedPlaylist {
  const range = (r?: { offset: number | bigint; length: number | bigint }) =>
    r ? { offset: Number(r.offset), length: Number(r.length) } : undefined;
  const segments: ParsedSegment[] = (playlist.segments || []).map((segment) => {
    const byteRange = range((segment as { byterange?: { offset: number | bigint; length: number | bigint } }).byterange);
    const initByteRange = range(segment.map?.byterange);
    return {
      uri: segment.resolvedUri || segment.uri,
      ...(byteRange ? { byteRange } : {}),
      ...(segment.map ? { initUri: segment.map.resolvedUri || segment.map.uri } : {}),
      ...(initByteRange ? { initByteRange } : {}),
    };
  });
  return { segments };
}

/**
 * Parse an MPD manifest string into a structured manifest object.
 */
export function parseManifest(mpdText: string, mpdUrl: string): MpdManifest {
  return parse(mpdText, { manifestUri: mpdUrl }) as MpdManifest;
}

/**
 * Parse an MPD manifest into Level[] (one Level per representation).
 * Mirrors parseMasterPlaylist() from m3u8-parser.ts.
 */
export function parseMasterPlaylist(mpdText: string, mpdUrl: string): Level[] {
  const manifest = parseManifest(mpdText, mpdUrl);
  return (manifest.playlists || []).map((playlist) => ({
    type: "stream" as LevelType,
    id: crypto.randomUUID(),
    playlistID: mpdUrl,
    uri: mpdUrl, // DASH representations all derive from the same MPD URL
    bitrate: playlist.attributes?.BANDWIDTH,
    height: playlist.attributes?.RESOLUTION?.height,
    width: playlist.attributes?.RESOLUTION?.width,
  }));
}

/**
 * Select the highest-bandwidth video playlist from a parsed MPD manifest
 * and return it as a ParsedPlaylist, ready for parseLevelsPlaylist().
 * Returns null if no video playlists are present.
 */
export function getVideoPlaylist(manifest: MpdManifest): ParsedPlaylist | null {
  const playlists = [...(manifest.playlists || [])];
  if (!playlists.length) return null;
  playlists.sort((a, b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0));
  return mpdPlaylistToParsedPlaylist(playlists[0]!);
}

/**
 * Select a video playlist by bandwidth, falling back to highest if not found.
 */
export function getVideoPlaylistByBandwidth(
  manifest: MpdManifest,
  bandwidth: number,
): ParsedPlaylist | null {
  const match = (manifest.playlists || []).find(
    (p) => p.attributes?.BANDWIDTH === bandwidth,
  );
  if (!match) return getVideoPlaylist(manifest);
  return mpdPlaylistToParsedPlaylist(match);
}

/**
 * Extract the first audio playlist from the parsed manifest's mediaGroups
 * and return it as a ParsedPlaylist, ready for parseLevelsPlaylist().
 * Returns null if no audio adaptation set is present.
 */
export function getAudioPlaylist(manifest: MpdManifest): ParsedPlaylist | null {
  const audioGroup = manifest.mediaGroups?.AUDIO?.audio;
  if (!audioGroup) return null;
  for (const group of Object.values(audioGroup)) {
    if (group.playlists?.length) {
      return mpdPlaylistToParsedPlaylist(group.playlists[0]!);
    }
  }
  return null;
}

/**
 * Detect whether an MPD describes a live (dynamic) stream.
 * Checks for `type="dynamic"` in the raw XML — more reliable than inspecting
 * the parsed output, which always sets minimumUpdatePeriod.
 */
export function isLive(mpdText: string): boolean {
  return /type\s*=\s*["']dynamic["']/i.test(mpdText);
}

/**
 * Check whether an MPD contains DRM (ContentProtection elements).
 */
export function hasDrm(mpdText: string): boolean {
  return detectDashDrm(mpdText) !== null;
}

/**
 * Extract the poll interval from minimumUpdatePeriod in the MPD.
 * Clamped to [1000ms, 10000ms]; defaults to 3000ms if not present.
 */
export function getPollIntervalMs(mpdText: string): number {
  const match = mpdText.match(/minimumUpdatePeriod\s*=\s*["']PT([\d.]+)S["']/i);
  if (!match) return 3000;
  const seconds = parseFloat(match[1]!);
  const ms = Math.round(seconds * 1000);
  return Math.max(1000, Math.min(ms, 10000));
}

export const MpdParser = {
  parseManifest,
  parseMasterPlaylist,
  parseLevelsPlaylist,
  getVideoPlaylist,
  getVideoPlaylistByBandwidth,
  getAudioPlaylist,
  isLive,
  hasDrm,
  getPollIntervalMs,
};
