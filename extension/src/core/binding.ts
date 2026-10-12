/**
 * Associate media detected on the network with the <video> elements of a frame.
 *
 * A player using Media Source Extensions shows `src="blob:…"`, which says
 * nothing about the manifest behind it. We only know *when* each element
 * started loading and *when* each manifest was detected. Pure: unit-tested.
 */

import { VideoFormat, type VideoMetadata } from "./types";

export interface VideoTiming {
  key: string;
  /** Epoch ms of the last `loadstart`/`emptied` on the element, 0 if unknown */
  loadStartedAt: number;
}

/** A manifest detected further away than this from any loadstart is not bound to a video. */
export const BINDING_WINDOW_MS = 20_000;

/** HLS master > DASH > plain media playlist > direct, then newest first. */
function relevance(m: VideoMetadata): number {
  switch (m.format) {
    case VideoFormat.HLS:
      return 3;
    case VideoFormat.DASH:
      return 3;
    case VideoFormat.M3U8:
      return 2;
    default:
      return 1;
  }
}

export function sortByRelevance(media: VideoMetadata[]): VideoMetadata[] {
  return [...media].sort(
    (a, b) => relevance(b) - relevance(a) || (b.detectedAt ?? 0) - (a.detectedAt ?? 0),
  );
}

/**
 * Returns, for each video key, the media list most likely to belong to it.
 * With a single video in the frame every media item belongs to it. With several,
 * each item goes to the video whose loadstart is closest in time; items too far
 * from every loadstart are offered to all videos as a fallback.
 */
export function bindMedia(videos: VideoTiming[], media: VideoMetadata[]): Map<string, VideoMetadata[]> {
  const result = new Map<string, VideoMetadata[]>();
  for (const v of videos) result.set(v.key, []);
  if (videos.length === 0 || media.length === 0) return result;

  if (videos.length === 1) {
    result.set(videos[0]!.key, sortByRelevance(media));
    return result;
  }

  const unbound: VideoMetadata[] = [];
  for (const m of media) {
    const t = m.detectedAt ?? 0;
    let best: VideoTiming | null = null;
    let bestDelta = Infinity;
    for (const v of videos) {
      if (!v.loadStartedAt || !t) continue;
      const delta = Math.abs(t - v.loadStartedAt);
      if (delta < bestDelta) {
        best = v;
        bestDelta = delta;
      }
    }
    if (best && bestDelta <= BINDING_WINDOW_MS) result.get(best.key)!.push(m);
    else unbound.push(m);
  }

  for (const [key, list] of result) {
    result.set(key, sortByRelevance(list.length > 0 ? list : unbound));
  }
  return result;
}
