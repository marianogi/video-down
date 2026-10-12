import { Fragment } from "../types";

export interface ByteRange {
  offset: number;
  length: number;
}

export interface ParsedSegment {
  uri: string;
  /** Part of `uri` to fetch (HLS EXT-X-BYTERANGE, DASH SegmentBase/indexRange) */
  byteRange?: ByteRange;
  initUri?: string; // EXT-X-MAP (HLS) or segment.map.resolvedUri (DASH)
  initByteRange?: ByteRange;
  /** Key for the init segment, only when the playlist declares one with an explicit IV */
  initKey?: { iv: string | null; uri: string | null };
  key?: { iv: string | null; uri: string | null }; // HLS only
}

export interface ParsedPlaylist {
  segments: ParsedSegment[];
}

function sameRange(a: ByteRange | undefined | null, b: ByteRange | undefined | null): boolean {
  return (a?.offset ?? -1) === (b?.offset ?? -1) && (a?.length ?? -1) === (b?.length ?? -1);
}

/**
 * Convert a ParsedPlaylist into a Fragment[] with sequential indices.
 *
 * Handles init segments (EXT-X-MAP for HLS, segment.map for DASH): inserts
 * each distinct init URI as a Fragment before the first media segment that
 * references it. Deduplicates by URI+byteRange so a shared init is only
 * downloaded once per run.
 *
 * `startIndex` allows audio fragments to continue numbering from where
 * video fragments left off (used by HLS/DASH dual-stream downloads).
 *
 * Forked from Media Bridge (MIT): byte ranges are now carried to the download
 * (before, every segment downloaded the whole file), and the init segment uses
 * its own key instead of the first media segment's.
 */
export function parseLevelsPlaylist(
  playlist: ParsedPlaylist,
  startIndex: number = 0,
): Fragment[] {
  const fragments: Fragment[] = [];
  let index = startIndex;
  let currentInitUri: string | null = null;
  let currentInitByteRange: ByteRange | null = null;

  for (const segment of playlist.segments) {
    if (segment.initUri) {
      const byteRange = segment.initByteRange ?? null;
      if (segment.initUri !== currentInitUri || !sameRange(byteRange, currentInitByteRange)) {
        fragments.push({
          index,
          key: segment.initKey ?? { iv: null, uri: null },
          uri: segment.initUri,
          ...(byteRange ? { byteRange } : {}),
        });
        index++;
        currentInitUri = segment.initUri;
        currentInitByteRange = byteRange;
      }
    }
    fragments.push({
      index,
      key: segment.key ?? { iv: null, uri: null },
      uri: segment.uri,
      ...(segment.byteRange ? { byteRange: segment.byteRange } : {}),
    });
    index++;
  }

  return fragments;
}
