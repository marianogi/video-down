/**
 * Follow a live HLS media playlist: on every reload, which segments are new.
 *
 * Segments are identified by their Media Sequence Number (RFC 8216 §6.3.2), never by URL:
 * CDNs rename and re-sign segment URLs. A recording starts at the live edge, like a player,
 * and notices when it fell behind (segments that left the playlist before being fetched) so
 * the gap is marked as a discontinuity instead of silently glued together. Pure: unit-tested.
 */

import { Parser } from "m3u8-parser";
import { buildAbsoluteURL } from "url-toolkit";
import { ivFromSequence, ivToHex } from "../parsers/m3u8-parser";
import type { ByteRange } from "../parsers/playlist-utils";

export interface LiveSegment {
  seq: number;
  uri: string;
  duration: number;
  /** A discontinuity in the source, or segments lost between this one and the previous */
  discontinuity: boolean;
  byteRange?: ByteRange;
  /** AES-128 only (anything else is DRM and never recorded) */
  key?: { uri: string; iv: string };
  /** EXT-X-MAP (fMP4) */
  map?: { uri: string; byteRange?: ByteRange };
}

export interface LiveUpdate {
  segments: LiveSegment[];
  /** #EXT-X-ENDLIST: the broadcast is over */
  ended: boolean;
  targetDuration: number;
  /** Segments that left the playlist before they could be fetched */
  lost: number;
  /** Sequence number of the newest segment in the playlist */
  lastSeq: number | null;
}

/** Segments a player keeps between itself and the live edge (hls.js and Safari use 3). */
export const LIVE_EDGE_SEGMENTS = 3;

function range(r: { offset?: number | bigint; length?: number | bigint } | undefined): ByteRange | undefined {
  if (!r || r.length === undefined) return undefined;
  return { offset: Number(r.offset ?? 0), length: Number(r.length) };
}

/**
 * @param lastSeq sequence number of the last segment already recorded, or null on the first load
 */
export function liveUpdate(playlistText: string, playlistUrl: string, lastSeq: number | null): LiveUpdate {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();
  const m = parser.manifest;
  const first = Number(m.mediaSequence ?? 0);
  const all = m.segments ?? [];
  const targetDuration = Number(m.targetDuration) || Math.max(1, ...all.map((s) => Math.ceil(s.duration ?? 0)));
  const ended = !!m.endList;

  let startIndex: number;
  let lost = 0;
  if (lastSeq === null) {
    // First load: begin at the live edge (an ended or event playlist is recorded whole).
    startIndex = ended ? 0 : Math.max(0, all.length - LIVE_EDGE_SEGMENTS);
  } else {
    startIndex = lastSeq + 1 - first;
    if (startIndex < 0) {
      lost = -startIndex;
      startIndex = 0;
    }
  }

  const segments: LiveSegment[] = [];
  for (let i = startIndex; i < all.length; i++) {
    const s = all[i]!;
    const seq = first + i;
    const seg: LiveSegment = {
      seq,
      uri: buildAbsoluteURL(playlistUrl, s.uri),
      duration: Number(s.duration) || targetDuration,
      discontinuity: !!s.discontinuity || (lost > 0 && segments.length === 0),
    };
    const br = range(s.byterange);
    if (br) seg.byteRange = br;
    if (s.key?.uri && (s.key.method ?? "AES-128") === "AES-128") {
      seg.key = { uri: buildAbsoluteURL(playlistUrl, s.key.uri), iv: s.key.iv ? ivToHex(s.key.iv) : ivFromSequence(seq) };
    }
    if (s.map?.uri) {
      const mr = range(s.map.byterange);
      seg.map = { uri: buildAbsoluteURL(playlistUrl, s.map.uri), ...(mr ? { byteRange: mr } : {}) };
    }
    segments.push(seg);
  }

  return {
    segments,
    ended,
    targetDuration,
    lost,
    lastSeq: all.length ? first + all.length - 1 : null,
  };
}

/** How long to wait before reloading (RFC 8216 §6.3.4): a target duration, half if nothing changed. */
export function reloadDelayMs(update: LiveUpdate): number {
  const base = Math.max(1, update.targetDuration) * 1000;
  return update.segments.length > 0 ? base : base / 2;
}

/** Whether a live playlist uses encryption that is not AES-128 (DRM): never recorded. */
export function hasUnsupportedKey(playlistText: string): boolean {
  return /#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=(?!NONE|AES-128\b)/i.test(playlistText);
}
