/**
 * HLS playlists describing what has been recorded so far, for the time-shift player.
 *
 * The recorder page plays its own recording with hls.js through a loader that serves these
 * playlists and the stored segments from IndexedDB: nothing goes to the network. While the
 * recording grows the playlist is an EVENT playlist without #EXT-X-ENDLIST, so the player
 * treats it as live (pause, rewind, back to the newest moment); once stopped it is complete.
 * Pure: unit-tested.
 */

export type TrackKind = "main" | "video" | "audio";

export interface PartRef {
  seq: number;
  duration: number;
  discontinuity?: boolean;
  /** Initialisation segment (fMP4) this part needs */
  initId?: number;
}

/** Fake origin for the loader: the URLs only need to be absolute and never leave the page. */
export const LOCAL_BASE = "https://recording.video-down.invalid";

export function partUrl(recordingId: string, track: TrackKind, seq: number): string {
  return `${LOCAL_BASE}/${recordingId}/${track}/part/${seq}`;
}

export function initUrl(recordingId: string, track: TrackKind, initId: number): string {
  return `${LOCAL_BASE}/${recordingId}/${track}/init/${initId}`;
}

export function playlistUrl(recordingId: string, name: "master" | TrackKind): string {
  return `${LOCAL_BASE}/${recordingId}/${name}.m3u8`;
}

export type LocalRequest =
  | { kind: "playlist"; recordingId: string; name: "master" | TrackKind }
  | { kind: "part"; recordingId: string; track: TrackKind; seq: number }
  | { kind: "init"; recordingId: string; track: TrackKind; initId: number };

/** What a loader URL asks for, or null for anything that is not ours. */
export function parseLocalUrl(url: string): LocalRequest | null {
  if (!url.startsWith(`${LOCAL_BASE}/`)) return null;
  const path = url.slice(LOCAL_BASE.length + 1).split(/[?#]/)[0]!;
  let m = path.match(/^([A-Za-z0-9_-]{1,64})\/(master|main|video|audio)\.m3u8$/);
  if (m) return { kind: "playlist", recordingId: m[1]!, name: m[2] as "master" | TrackKind };
  m = path.match(/^([A-Za-z0-9_-]{1,64})\/(main|video|audio)\/(part|init)\/(\d{1,9})$/);
  if (!m) return null;
  const n = Number(m[4]);
  return m[3] === "part"
    ? { kind: "part", recordingId: m[1]!, track: m[2] as TrackKind, seq: n }
    : { kind: "init", recordingId: m[1]!, track: m[2] as TrackKind, initId: n };
}

export function mediaPlaylist(recordingId: string, track: TrackKind, parts: PartRef[], complete: boolean): string {
  const target = Math.max(1, ...parts.map((p) => Math.ceil(p.duration)));
  const usesMap = parts.some((p) => p.initId !== undefined);
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${usesMap ? 7 : 3}`,
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  let currentInit: number | undefined;
  parts.forEach((p, i) => {
    if (i > 0 && p.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    if (p.initId !== undefined && p.initId !== currentInit) {
      if (i > 0 && currentInit !== undefined && !p.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
      lines.push(`#EXT-X-MAP:URI="${initUrl(recordingId, track, p.initId)}"`);
      currentInit = p.initId;
    }
    lines.push(`#EXTINF:${p.duration.toFixed(3)},`, partUrl(recordingId, track, p.seq));
  });
  if (complete) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/** Master for recordings with separate video and audio tracks. */
export function masterPlaylist(recordingId: string, hasAudio: boolean, codecs?: string, bandwidth = 2_000_000): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  const codecAttr = codecs ? `,CODECS="${codecs}"` : "";
  if (hasAudio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="${playlistUrl(recordingId, "audio")}"`,
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${codecAttr},AUDIO="a"`,
    );
  } else {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${codecAttr}`);
  }
  lines.push(playlistUrl(recordingId, hasAudio ? "video" : "main"));
  return `${lines.join("\n")}\n`;
}
