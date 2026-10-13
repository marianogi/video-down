import { describe, expect, it } from "vitest";
import { fixVp9Level, Mp4FragmentSplitter, parseMoov } from "../src/core/recording/mp4-fragments";
import { liveUpdate, reloadDelayMs, hasUnsupportedKey, LIVE_EDGE_SEGMENTS } from "../src/core/recording/hls-live";
import { mediaPlaylist, masterPlaylist, parseLocalUrl, partUrl, initUrl, playlistUrl } from "../src/core/recording/local-playlist";
import { CAPTURE_PROFILES, pickMimeType, videoBitrate, bytesPerHour, codecLabel, profileById } from "../src/core/recording/profiles";

// ------------------------------------------------------------------ a tiny fragmented MP4, byte by byte

const u8 = (...n: number[]) => new Uint8Array(n);
function u32(n: number): Uint8Array {
  return u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}
function u64(n: number): Uint8Array {
  return cat(u32(Math.floor(n / 2 ** 32)), u32(n >>> 0));
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = cat(...payload);
  return cat(u32(8 + body.length), new TextEncoder().encode(type), body);
}
const full = (version: number, flags: number) => u32(((version & 255) << 24) | flags);

function trak(id: number, handler: string, timescale: number): Uint8Array {
  const tkhd = box("tkhd", full(0, 3), u32(0), u32(0), u32(id), new Uint8Array(60));
  const mdhd = box("mdhd", full(0, 0), u32(0), u32(0), u32(timescale), u32(0), new Uint8Array(4));
  const hdlr = box("hdlr", full(0, 0), u32(0), new TextEncoder().encode(handler), new Uint8Array(12), u8(0));
  return box("trak", tkhd, box("mdia", mdhd, hdlr));
}

const ftyp = box("ftyp", new TextEncoder().encode("isom"), u32(0));
const moov = box(
  "moov",
  trak(1, "vide", 1000),
  trak(2, "soun", 48000),
  box("mvex", box("trex", full(0, 0), u32(2), u32(1), u32(1024), u32(0), u32(0))),
);

function fragment(videoBase: number, audioBase: number, payload: number): Uint8Array {
  const vtraf = box(
    "traf",
    box("tfhd", full(0, 0), u32(1)),
    box("tfdt", full(1, 0), u64(videoBase)),
    box("trun", full(0, 0x100), u32(2), u32(250), u32(250)),
  );
  const atraf = box("traf", box("tfhd", full(0, 0), u32(2)), box("tfdt", full(0, 0), u32(audioBase)), box("trun", full(0, 0), u32(23)));
  return cat(box("moof", vtraf, atraf), box("mdat", new Uint8Array(payload).fill(7)));
}

describe("fragmented MP4 from MediaRecorder", () => {
  it("gives VP9 a valid level (MediaRecorder writes 0, which Chrome's player refuses)", () => {
    const vpcC = box("vpcC", full(1, 0), u8(0, 0, 0x80, 1, 1, 1), u8(0, 0));
    const init = cat(ftyp, box("moov", box("stsd", vpcC)));
    const fixed = fixVp9Level(init.slice());
    const at = fixed.length - vpcC.length + 13;
    expect(init[at]).toBe(0);
    expect(fixed[at]).toBe(40);
    const already = cat(ftyp, box("moov", box("vpcC", full(1, 0), u8(0, 31, 0x80, 1, 1, 1), u8(0, 0))));
    expect(fixVp9Level(already.slice())).toEqual(already);
  });

  it("reads the tracks of the moov box", () => {
    const tracks = parseMoov(cat(ftyp, moov));
    expect(tracks.get(1)).toMatchObject({ kind: "video", timescale: 1000 });
    expect(tracks.get(2)).toMatchObject({ kind: "audio", timescale: 48000, defaultDuration: 1024 });
  });

  it("cuts arbitrary slices into the init segment and timed fragments", () => {
    const f1 = fragment(0, 0, 300);
    const f2 = fragment(500, 23552, 200);
    const stream = cat(ftyp, moov, f1, f2);
    const s = new Mp4FragmentSplitter();
    let init: Uint8Array | undefined;
    const fragments = [];
    for (let i = 0; i < stream.length; i += 7) {
      const out = s.push(stream.subarray(i, i + 7));
      if (out.init) {
        expect(init).toBeUndefined();
        init = out.init;
      }
      fragments.push(...out.fragments);
    }
    expect(init).toEqual(cat(ftyp, moov));
    expect(fragments.map((f) => [f.start, f.duration])).toEqual([
      [0, 0.5],
      [0.5, 0.5],
    ]);
    expect(cat(...fragments.map((f) => f.bytes))).toEqual(cat(f1, f2));
    expect(s.flush()).toEqual([]);
  });
});

// ------------------------------------------------------------------ live HLS

function live(first: number, count: number, opts: { end?: boolean; key?: string } = {}): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", `#EXT-X-MEDIA-SEQUENCE:${first}`];
  if (opts.key) lines.push(opts.key);
  for (let i = 0; i < count; i++) lines.push("#EXTINF:4.0,", `seg${first + i}.ts?token=x`);
  if (opts.end) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

describe("following a live HLS playlist", () => {
  const url = "https://cdn.example.com/live/index.m3u8?t=1";

  it("starts at the live edge, like a player", () => {
    const u = liveUpdate(live(100, 6), url, null);
    expect(u.segments.map((s) => s.seq)).toEqual([103, 104, 105]);
    expect(u.segments).toHaveLength(LIVE_EDGE_SEGMENTS);
    expect(u.segments[0]!.uri).toBe("https://cdn.example.com/live/seg103.ts?token=x");
    expect(u).toMatchObject({ ended: false, lastSeq: 105, lost: 0, targetDuration: 4 });
  });

  it("takes only what is new, by sequence number", () => {
    const u = liveUpdate(live(103, 6), url, 105);
    expect(u.segments.map((s) => s.seq)).toEqual([106, 107, 108]);
    expect(u.segments.some((s) => s.discontinuity)).toBe(false);
    expect(reloadDelayMs(u)).toBe(4000);
    expect(reloadDelayMs(liveUpdate(live(103, 6), url, 108))).toBe(2000);
  });

  it("marks a gap when it fell behind the playlist", () => {
    const u = liveUpdate(live(110, 6), url, 105);
    expect(u.lost).toBe(4);
    expect(u.segments[0]).toMatchObject({ seq: 110, discontinuity: true });
    expect(u.segments[1]!.discontinuity).toBe(false);
  });

  it("derives AES-128 IVs from the sequence and notices the end of the broadcast", () => {
    const u = liveUpdate(live(7, 2, { key: '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', end: true }), url, null);
    expect(u.ended).toBe(true);
    expect(u.segments.map((s) => s.seq)).toEqual([7, 8]);
    expect(u.segments[1]!.key).toEqual({ uri: "https://cdn.example.com/live/k.bin", iv: "00000000000000000000000000000008" });
  });

  it("refuses DRM key methods", () => {
    expect(hasUnsupportedKey('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"')).toBe(true);
    expect(hasUnsupportedKey('#EXT-X-KEY:METHOD=AES-128,URI="k"')).toBe(false);
    expect(hasUnsupportedKey("#EXT-X-KEY:METHOD=NONE")).toBe(false);
  });
});

// ------------------------------------------------------------------ local playlists for the time-shift player

describe("time-shift playlists", () => {
  it("describe what was recorded, as a growing EVENT playlist", () => {
    const text = mediaPlaylist("rec1", "main", [
      { seq: 0, duration: 1.0, initId: 0 },
      { seq: 1, duration: 1.04, initId: 0 },
      { seq: 2, duration: 2, initId: 1, discontinuity: true },
    ], false);
    expect(text).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(text).toContain("#EXT-X-TARGETDURATION:2");
    expect(text).not.toContain("#EXT-X-ENDLIST");
    expect(text.match(/#EXT-X-MAP/g)).toHaveLength(2);
    expect(text.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    expect(text).toContain(`#EXTINF:1.040,\n${partUrl("rec1", "main", 1)}`);
    expect(mediaPlaylist("rec1", "main", [{ seq: 0, duration: 4 }], true)).toContain("#EXT-X-ENDLIST");
  });

  it("only its own URLs are served by the local loader", () => {
    expect(parseLocalUrl(partUrl("rec1", "video", 12))).toEqual({ kind: "part", recordingId: "rec1", track: "video", seq: 12 });
    expect(parseLocalUrl(initUrl("rec1", "audio", 0))).toEqual({ kind: "init", recordingId: "rec1", track: "audio", initId: 0 });
    expect(parseLocalUrl(playlistUrl("rec1", "master"))).toEqual({ kind: "playlist", recordingId: "rec1", name: "master" });
    expect(parseLocalUrl("https://example.com/rec1/main.m3u8")).toBeNull();
    expect(parseLocalUrl(`${partUrl("rec1", "main", 1)}/../../x`)).toBeNull();
    expect(masterPlaylist("rec1", true)).toContain('AUDIO="a"');
  });
});

// ------------------------------------------------------------------ capture profiles

describe("capture profiles", () => {
  it("use the first codec this browser can record", () => {
    const quality = profileById("quality")!;
    expect(pickMimeType(quality, (t) => t.includes("opus"))).toBe('video/mp4;codecs="avc1.640028,opus"');
    expect(pickMimeType(quality, () => false)).toBeNull();
    expect(codecLabel('video/mp4;codecs="av01.0.08M.08,opus"')).toBe("AV1");
    expect(codecLabel('video/mp4;codecs="vp9,opus"')).toBe("VP9");
    expect(CAPTURE_PROFILES.map((p) => p.id)).toEqual(["quality", "balanced", "small", "light"]);
  });

  it("scale the bitrate with the picture, within limits", () => {
    const balanced = profileById("balanced")!;
    expect(videoBitrate(balanced, 1920, 1080)).toBe(Math.round(0.06 * 1920 * 1080 * 30));
    expect(videoBitrate(balanced, 160, 90)).toBe(400_000);
    expect(videoBitrate(profileById("quality")!, 7680, 4320, 60)).toBe(25_000_000);
    expect(bytesPerHour(8_000_000)).toBe(3_600_000_000);
  });
});
