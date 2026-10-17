import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { route, youtubeWatchUrl, isManifestUrl, BLOB_GRACE_MS, type RouteInput } from "../src/core/router";
import { bindMedia, BINDING_WINDOW_MS } from "../src/core/binding";
import { hlsVariants, dashVariants } from "../src/core/variants";
import { detectHlsDrm, detectDashDrm, canDecrypt } from "../src/core/utils/drm-utils";
import { resolveSettings } from "../src/core/storage/settings";
import { VideoFormat, type VideoMetadata } from "../src/core/types";
import { t, useBundledMessages } from "../src/shared/i18n";
import enMessages from "../public/_locales/en/messages.json";
import esMessages from "../public/_locales/es/messages.json";

const fixture = (name: string) => readFileSync(resolve(__dirname, "fixtures", name), "utf8");

function media(partial: Partial<VideoMetadata>): VideoMetadata {
  return { url: "https://cdn.example.com/master.m3u8", format: VideoFormat.HLS, pageUrl: "https://example.com/", ...partial };
}

function input(partial: Omit<Partial<RouteInput>, "video"> & { video?: Partial<RouteInput["video"]> } = {}): RouteInput {
  return {
    pageUrl: "https://example.com/watch/1",
    media: [],
    nativeAvailable: false,
    ...partial,
    video: { src: "", sources: [], loadingForMs: 0, ...partial.video },
  };
}

// ------------------------------------------------------------------ router

describe("router", () => {
  it("plain file goes straight to Chrome downloads", () => {
    const r = route(input({ video: { src: "https://example.com/a.mp4" } }));
    expect(r).toEqual({ kind: "direct", sources: [{ url: "https://example.com/a.mp4" }] });
  });

  it("several <source> qualities are all offered", () => {
    const r = route(
      input({
        video: {
          src: "https://example.com/720.mp4",
          sources: [
            { url: "https://example.com/1080.mp4", height: 1080 },
            { url: "https://example.com/720.mp4", height: 720 },
          ],
        },
      }),
    );
    expect(r.kind).toBe("direct");
    if (r.kind === "direct") expect(r.sources.map((s) => s.height)).toEqual([1080, 720]);
  });

  it("a playlist in <video src> is not treated as a file", () => {
    expect(isManifestUrl("https://x.org/live/index.m3u8?token=1")).toBe(true);
    const r = route(input({ video: { src: "https://x.org/index.m3u8", loadingForMs: 100 } }));
    expect(r.kind).toBe("pending");
  });

  it("HLS manifest bound to a blob video uses the browser engine", () => {
    const m = media({});
    const r = route(input({ video: { src: "blob:https://example.com/x", loadingForMs: 500 }, media: [m] }));
    expect(r).toEqual({ kind: "manifest", media: m });
  });

  it("EME on the element always wins: DRM", () => {
    const r = route(
      input({ video: { src: "https://example.com/a.mp4", drm: "com.widevine.alpha" }, nativeAvailable: true }),
    );
    expect(r).toEqual({ kind: "drm", system: "com.widevine.alpha" });
  });

  it("DRM declared in the manifest blocks the download", () => {
    const r = route(input({ video: { src: "blob:x" }, media: [media({ hasDrm: true, drmSystem: "Widevine" })] }));
    expect(r).toEqual({ kind: "drm", system: "Widevine" });
  });

  it("live-only streams are reported as live", () => {
    expect(route(input({ video: { src: "blob:x" }, media: [media({ isLive: true })] }))).toEqual({ kind: "live" });
  });

  it("YouTube needs the native component", () => {
    const page = "https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=10";
    expect(route(input({ pageUrl: page, video: { src: "blob:x" } }))).toEqual({
      kind: "need-native",
      reason: "youtube",
    });
    expect(route(input({ pageUrl: page, video: { src: "blob:x" }, nativeAvailable: true }))).toEqual({
      kind: "native",
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      reason: "youtube",
    });
  });

  it("YouTube home page (no single video) waits", () => {
    expect(route(input({ pageUrl: "https://www.youtube.com/", nativeAvailable: true })).kind).toBe("pending");
  });

  it("blob video without manifest waits, then needs the native component", () => {
    expect(route(input({ video: { src: "blob:x", loadingForMs: 1000 } })).kind).toBe("pending");
    expect(route(input({ video: { src: "blob:x", loadingForMs: BLOB_GRACE_MS } }))).toEqual({
      kind: "need-native",
      reason: "unknown-stream",
    });
    expect(route(input({ video: { src: "blob:x", loadingForMs: BLOB_GRACE_MS }, nativeAvailable: true }))).toEqual({
      kind: "native",
      url: "https://example.com/watch/1",
      reason: "unknown-stream",
    });
  });
});

describe("youtubeWatchUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=aqz-KE-bpKQ", "aqz-KE-bpKQ"],
    ["https://m.youtube.com/watch?v=aqz-KE-bpKQ&list=x", "aqz-KE-bpKQ"],
    ["https://youtu.be/aqz-KE-bpKQ?si=abc", "aqz-KE-bpKQ"],
    ["https://www.youtube.com/shorts/aqz-KE-bpKQ", "aqz-KE-bpKQ"],
    ["https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1", "aqz-KE-bpKQ"],
  ])("%s", (page, id) => {
    expect(youtubeWatchUrl(page)).toBe(`https://www.youtube.com/watch?v=${id}`);
  });

  it("rejects malformed ids and other hosts", () => {
    expect(youtubeWatchUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youtubeWatchUrl("https://www.youtube.com/watch?v=aqz-KE-bpKQ%22%3E")).toBeNull();
    expect(youtubeWatchUrl("https://evil.example/watch?v=aqz-KE-bpKQ")).toBeNull();
  });
});

// ------------------------------------------------------------------ binding

describe("bindMedia", () => {
  it("single video gets everything, HLS master first", () => {
    const a = media({ url: "https://x/a.m3u8", format: VideoFormat.M3U8, detectedAt: 5 });
    const b = media({ url: "https://x/b.m3u8", format: VideoFormat.HLS, detectedAt: 1 });
    expect(bindMedia([{ key: "v1", loadStartedAt: 0 }], [a, b]).get("v1")).toEqual([b, a]);
  });

  it("two videos: each manifest goes to the closest loadstart", () => {
    const t0 = 1_000_000;
    const m1 = media({ url: "https://x/1.m3u8", detectedAt: t0 + 300 });
    const m2 = media({ url: "https://x/2.m3u8", detectedAt: t0 + 10_300 });
    const out = bindMedia(
      [
        { key: "v1", loadStartedAt: t0 },
        { key: "v2", loadStartedAt: t0 + 10_000 },
      ],
      [m1, m2],
    );
    expect(out.get("v1")).toEqual([m1]);
    expect(out.get("v2")).toEqual([m2]);
  });

  it("manifests far from any loadstart are offered to every video", () => {
    const m = media({ detectedAt: 1 });
    const out = bindMedia(
      [
        { key: "v1", loadStartedAt: BINDING_WINDOW_MS * 10 },
        { key: "v2", loadStartedAt: BINDING_WINDOW_MS * 20 },
      ],
      [m],
    );
    expect(out.get("v1")).toEqual([m]);
    expect(out.get("v2")).toEqual([m]);
  });
});

// ------------------------------------------------------------------ variants

describe("hlsVariants", () => {
  it("one entry per height, best bitrate, absolute URLs, separate audio", () => {
    const v = hlsVariants(fixture("master.m3u8"), "https://cdn.example.com/show/master.m3u8", 600);
    expect(v.map((x) => x.label)).toEqual(["1080p", "720p", "360p"]);
    expect(v[0]!.manifestQuality).toEqual({
      videoPlaylistUrl: "https://cdn.example.com/v1080/index.m3u8",
      audioPlaylistUrl: "https://cdn.example.com/show/audio/en.m3u8",
    });
    expect(v[1]!.manifestQuality?.videoPlaylistUrl).toBe("https://cdn.example.com/show/v720/index.m3u8");
    expect(v[0]!.approxBytes).toBe((5_000_000 * 600) / 8);
  });

  it("a media playlist is a single original entry", () => {
    expect(hlsVariants(fixture("media.m3u8"), "https://x/media.m3u8")).toEqual([{ id: "original", label: "original" }]);
  });
});

describe("dashVariants", () => {
  it("one entry per video representation, size includes audio", () => {
    const v = dashVariants(fixture("clear.mpd"), "https://cdn.example.com/manifest.mpd");
    expect(v.map((x) => x.label)).toEqual(["1080p", "480p"]);
    expect(v[0]!.manifestQuality).toEqual({ selectedBandwidth: 4_000_000 });
    expect(v[0]!.approxBytes).toBe(Math.round(((4_000_000 + 128_000) * 60) / 8));
  });
});

// ------------------------------------------------------------------ DRM

describe("DRM detection", () => {
  it("AES-128 with a published key is not DRM", () => {
    expect(detectHlsDrm(fixture("media.m3u8"))).toBeNull();
    expect(canDecrypt(fixture("media.m3u8"))).toBe(true);
  });

  it("HLS: SAMPLE-AES, Widevine, FairPlay and PlayReady are DRM", () => {
    expect(detectHlsDrm('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"')).toBe(
      "FairPlay",
    );
    expect(
      detectHlsDrm('#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'),
    ).toBe("Widevine");
    expect(detectHlsDrm('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:x"')).toBe("SAMPLE-AES");
    expect(detectHlsDrm('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.microsoft.playready"')).toBe("PlayReady");
  });

  it("DASH: the cenc namespace alone is not DRM, ContentProtection is", () => {
    expect(detectDashDrm(fixture("clear.mpd"))).toBeNull();
    expect(detectDashDrm(fixture("widevine.mpd"))).toBe("Widevine");
  });
});

// ------------------------------------------------------------------ settings

describe("resolveSettings", () => {
  it("applies defaults and keeps stored values", () => {
    const s = resolveSettings({ askWhereToSave: true, maxConcurrent: 6 });
    expect(s.askWhereToSave).toBe(true);
    expect(s.maxConcurrent).toBe(6);
    expect(s.showOverlay).toBe(true);
    expect(s.preferNativeAboveMb).toBe(1500);
    expect(resolveSettings(null).minVideoWidth).toBe(120);
  });
});

// ------------------------------------------------------------------ detection failures

import { describeBody, redactUrl, statusFromError } from "../src/core/detection/detection-failure";

describe("detection failures", () => {
  it("classifies what came back instead of a playlist", () => {
    expect(describeBody("<!DOCTYPE html><html><body>Forbidden</body></html>")).toBe("html");
    expect(describeBody('{"error":"expired"}')).toBe("json");
    expect(describeBody("<Error><Code>AccessDenied</Code></Error>")).toBe("xml");
    expect(describeBody("")).toBe("empty");
    expect(describeBody(String.fromCharCode(...Array.from({ length: 200 }, (_, i) => (i * 7) % 32)))).toBe("binary");
    expect(describeBody("hello world")).toBe("text");
  });

  it("never keeps tokens when describing a URL", () => {
    expect(redactUrl("https://cdn.example.com/v/1/master.m3u8?hdnts=exp=1~acl=*~hmac=abc&sig=x")).toBe(
      "cdn.example.com/v/1/master.m3u8",
    );
  });

  it("reads the HTTP status from fetch errors", () => {
    expect(statusFromError(new Error("HTTP 403 Forbidden"))).toBe(403);
    expect(statusFromError(new Error("Failed to fetch"))).toBeUndefined();
  });
});

// ------------------------------------------------------------------ HLS segments (RFC 8216)

import { parseMediaPlaylist, ivFromSequence, ivToHex } from "../src/core/parsers/m3u8-parser";
import { parseLevelsPlaylist } from "../src/core/parsers/playlist-utils";

describe("HLS media playlist parsing", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:4",
    "#EXT-X-MEDIA-SEQUENCE:7",
    "#EXT-X-TARGETDURATION:4",
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k"',
    "#EXTINF:4,",
    "#EXT-X-BYTERANGE:1000@720",
    "all.ts",
    "#EXTINF:4,",
    "#EXT-X-BYTERANGE:2000",
    "all.ts",
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k",IV=0x0000000a000000000000ab0000000001',
    "#EXTINF:4,",
    "seg3.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");

  it("derives the IV from the media sequence number when the playlist omits it", () => {
    const { segments } = parseMediaPlaylist(playlist, "https://cdn.example.com/v/index.m3u8");
    expect(segments[0]!.key).toEqual({ uri: "https://keys.example.com/k", iv: ivFromSequence(7) });
    expect(segments[1]!.key?.iv).toBe(ivFromSequence(8));
    expect(ivFromSequence(7)).toBe("00000000000000000000000000000007");
  });

  it("keeps explicit IVs intact, leading zero bytes included", () => {
    const { segments } = parseMediaPlaylist(playlist, "https://cdn.example.com/v/index.m3u8");
    expect(segments[2]!.key?.iv).toBe("0000000a000000000000ab0000000001");
    expect(ivToHex(new Uint32Array([0x0a, 0, 0xab00, 1]))).toBe("0000000a000000000000ab0000000001");
  });

  it("carries EXT-X-BYTERANGE to the fragments", () => {
    const fragments = parseLevelsPlaylist(parseMediaPlaylist(playlist, "https://cdn.example.com/v/index.m3u8"));
    expect(fragments[0]!.byteRange).toEqual({ offset: 720, length: 1000 });
    expect(fragments[1]!.byteRange).toEqual({ offset: 1720, length: 2000 });
    expect(fragments[2]!.byteRange).toBeUndefined();
    expect(fragments[0]!.uri).toBe("https://cdn.example.com/v/all.ts");
  });

  it("ignores SAMPLE-AES (DRM is never decrypted)", () => {
    const { segments } = parseMediaPlaylist(
      ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"', "#EXTINF:4,", "a.ts", "#EXT-X-ENDLIST"].join("\n"),
      "https://cdn.example.com/",
    );
    expect(segments[0]!.key).toBeUndefined();
  });
});

// ------------------------------------------------------------------ master discovery

import { masterCandidates, withInheritedQuery } from "../src/core/parsers/master-discovery";
import { PlaylistBodies } from "../src/core/detection/playlist-bodies";
import { diagUrl, formatDiagnostics } from "../src/core/diagnostics";

describe("master discovery", () => {
  it("Unified Origin: strips the track selection and keeps the token", () => {
    const c = masterCandidates("https://cdn.example.com/v/1/hls/master-t-9-audio_eng=128005-video_eng=2781000.m3u8?hdnts=abc");
    expect(c[0]).toBe("https://cdn.example.com/v/1/hls/master-t-9.m3u8?hdnts=abc");
  });

  it("Wowza and nginx-vod conventions", () => {
    expect(masterCandidates("https://w.example.com/app/stream/chunklist_w12_b800000.m3u8")[0]).toBe(
      "https://w.example.com/app/stream/playlist.m3u8",
    );
    expect(masterCandidates("https://n.example.com/hls/x.mp4/index-v1-a1.m3u8")[0]).toBe(
      "https://n.example.com/hls/x.mp4/master.m3u8",
    );
  });

  it("rendition suffixes and rendition folders", () => {
    expect(masterCandidates("https://e.example.com/out/movie_720p.m3u8")[0]).toBe("https://e.example.com/out/movie.m3u8");
    const folder = masterCandidates("https://e.example.com/vod/abc/720p/index.m3u8?t=1");
    expect(folder).toContain("https://e.example.com/vod/abc/master.m3u8?t=1");
    expect(folder).toContain("https://e.example.com/vod/abc/playlist.m3u8?t=1");
  });

  it("never more than four guesses, never the playlist itself, nothing for non-HLS", () => {
    const c = masterCandidates("https://e.example.com/vod/720p/master_720p.m3u8");
    expect(c.length).toBeLessThanOrEqual(4);
    expect(c).not.toContain("https://e.example.com/vod/720p/master_720p.m3u8");
    expect(masterCandidates("https://e.example.com/master.m3u8")).toEqual([]);
    expect(masterCandidates("https://e.example.com/video.mp4")).toEqual([]);
    expect(masterCandidates("blob:https://e.example.com/1")).toEqual([]);
  });

  it("variants of a guessed master inherit the token they lack", () => {
    const master = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "v-360.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
      "v-720.m3u8?own=1",
    ].join("\n");
    const out = withInheritedQuery(master, "https://cdn.example.com/v-360.m3u8?hdnts=abc");
    expect(out).toContain("\nv-360.m3u8?hdnts=abc\n");
    expect(out).toContain('URI="audio.m3u8?hdnts=abc"');
    expect(out).toContain("\nv-720.m3u8?own=1");
    expect(withInheritedQuery(master, "https://cdn.example.com/v-360.m3u8")).toBe(master);
  });
});

describe("playlist copies kept from the player", () => {
  it("answers only for the exact address: another query string may be another video", () => {
    const b = new PlaylistBodies();
    b.set("https://cdn.example.com/m.m3u8?video=1", "#EXTM3U one", 1);
    b.set("https://cdn.example.com/m.m3u8?video=2", "#EXTM3U two", 2);
    expect(b.get("https://cdn.example.com/m.m3u8?video=1#t=3")).toBe("#EXTM3U one");
    expect(b.get("https://cdn.example.com/m.m3u8?video=2")).toBe("#EXTM3U two");
    expect(b.get("https://cdn.example.com/m.m3u8?video=3")).toBeUndefined();
  });

  it("stays within its limits and forgets old copies", () => {
    const b = new PlaylistBodies(2, 100);
    b.set("https://a.example.com/1.m3u8", "x".repeat(40), 1);
    b.set("https://a.example.com/2.m3u8", "y".repeat(40), 2);
    b.set("https://a.example.com/3.m3u8", "z".repeat(40), 3);
    expect(b.size).toBe(2);
    expect(b.get("https://a.example.com/1.m3u8")).toBeUndefined();
    b.set("https://a.example.com/big.m3u8", "w".repeat(101), 4);
    expect(b.get("https://a.example.com/big.m3u8")).toBeUndefined();
    b.dropBefore(3);
    expect(b.get("https://a.example.com/2.m3u8")).toBeUndefined();
    expect(b.get("https://a.example.com/3.m3u8")).toBe("z".repeat(40));
  });
});

describe("diagnostic report", () => {
  it("keeps host and path, never the query or fragment", () => {
    expect(diagUrl("https://cdn.example.com/a/b.m3u8?hdnts=secret#x")).toBe("cdn.example.com/a/b.m3u8?…");
    expect(diagUrl("https://cdn.example.com/a/b.m3u8")).toBe("cdn.example.com/a/b.m3u8");
    expect(diagUrl("blob:https://x.example.com/1")).toBe("blob:…");
  });

  it("lists frames and events in time order", () => {
    const text = formatDiagnostics({
      generatedAt: Date.UTC(2026, 9, 13, 20, 0, 0),
      version: "0.1.6",
      platform: "win x86-64",
      browser: "Chrome/141.0.0.0",
      native: "installed",
      tabUrl: "https://course.example.com/lesson/1?token=secret",
      frames: [{ frameId: 7, url: "player.example.com/embed/1?…" }, { frameId: 0, url: "course.example.com/lesson/1?…" }],
      entries: [
        { at: 2000, frameId: 7, source: "frame", event: "master", url: "cdn.example.com/m.m3u8?…", detail: "5 variant(s)" },
        { at: 1000, frameId: 7, source: "network", event: "HTTP 200", url: "cdn.example.com/m.m3u8?…" },
        { at: 1500, frameId: null, source: "worker", event: "HTTP 200", url: "cdn.example.com/x.m3u8" },
      ],
    });
    expect(text).toContain("video-down 0.1.6");
    expect(text).not.toContain("secret");
    expect(text.indexOf("#0 course.example.com")).toBeLessThan(text.indexOf("#7 player.example.com"));
    const network = text.indexOf("network HTTP 200");
    const worker = text.indexOf("SW    worker  HTTP 200");
    const master = text.indexOf("frame   master");
    expect(network).toBeGreaterThan(0);
    expect(worker).toBeGreaterThan(network);
    expect(master).toBeGreaterThan(worker);
    expect(text).toContain("(5 variant(s))");
  });
});

// ------------------------------------------------------------------ where yt-dlp saves (the path Chrome chose)

import { saveTargetFromPath } from "../src/core/native/save-target";

describe("where yt-dlp saves", () => {
  it("takes the folder and the name Chrome chose; yt-dlp adds the real extension", () => {
    expect(saveTargetFromPath("F:\\Descargas\\¡ESCUCHO OPINIONES! 1080p.mp4")).toEqual({ dir: "F:\\Descargas", name: "¡ESCUCHO OPINIONES! 1080p" });
    expect(saveTargetFromPath("/Users/me/Movies/clip (1).mp4")).toEqual({ dir: "/Users/me/Movies", name: "clip (1)" });
    expect(saveTargetFromPath("D:\\video.mp4")).toEqual({ dir: "D:\\", name: "video" });
    expect(saveTargetFromPath("f3b2c1d0-guid")).toBeNull();
    expect(saveTargetFromPath("relative/dir/x.mp4")).toBeNull();
  });
});

// ------------------------------------------------------------------ previews (a video inside a link)

describe("previews", () => {
  const teaser = { src: "blob:https://www.youtube.com/x", previewOf: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=abc" };

  it("a YouTube preview downloads the full video through yt-dlp, never the teaser", () => {
    const manifest = media({ format: VideoFormat.HLS, url: "https://cdn.example.com/teaser.m3u8" });
    expect(route(input({ pageUrl: "https://www.youtube.com/results?search_query=x", video: teaser, media: [manifest], nativeAvailable: true }))).toEqual({
      kind: "native",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      reason: "youtube",
    });
  });

  it("any other preview goes to the page it links to", () => {
    const video = { src: "https://example.com/teaser.mp4", previewOf: "https://example.com/videos/42" };
    expect(route(input({ video, nativeAvailable: true }))).toEqual({ kind: "native", url: "https://example.com/videos/42", reason: "preview" });
    expect(route(input({ video }))).toEqual({ kind: "need-native", reason: "preview" });
  });

  it("a YouTube page that is not a video, without a known preview link: asks to open the video", () => {
    expect(route(input({ pageUrl: "https://www.youtube.com/", video: { src: "blob:https://www.youtube.com/x" }, nativeAvailable: true }))).toEqual({
      kind: "pending",
      reason: "open-video",
    });
  });

  it("DRM still wins", () => {
    expect(route(input({ video: { ...teaser, drm: "com.widevine.alpha" }, nativeAvailable: true })).kind).toBe("drm");
  });
});

// ------------------------------------------------------------------ masters written by Unified Streaming

import { errorDetail } from "../src/core/detection/detection-failure";

describe("master with an audio rendition without URI (audio muxed in the variants)", () => {
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:4",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aacl-128",LANGUAGE="en",NAME="English",AUTOSELECT=YES,DEFAULT=YES,CHANNELS="2"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2924000,CODECS="mp4a.40.2,avc1.640028",RESOLUTION=1920x1080,AUDIO="audio-aacl-128"',
    "x-audio_eng=128005-video_eng=2781000.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=1280x720,AUDIO="audio-aacl-128"',
    "x-audio_eng=128005-video_eng=900000.m3u8",
  ].join(String.fromCharCode(10));

  it("lists every quality and downloads no separate audio", () => {
    const variants = hlsVariants(master, "https://cdn.example.com/hls/master.m3u8");
    expect(variants.map((v) => v.label)).toEqual(["1080p", "720p"]);
    expect(variants[0]!.manifestQuality).toEqual({
      videoPlaylistUrl: "https://cdn.example.com/hls/x-audio_eng=128005-video_eng=2781000.m3u8",
      audioPlaylistUrl: null,
    });
  });

  it("reports what went wrong without the addresses", () => {
    expect(errorDetail(new TypeError("bad https://cdn.example.com/a.m3u8?token=x here"))).toBe("TypeError: bad … here");
  });
});

// ------------------------------------------------------------------ site session for yt-dlp

import { needsSession, toSessionCookie } from "../src/core/native/site-session";

describe("site session for yt-dlp", () => {
  it("recognises the errors a session can fix, and only those", () => {
    for (const msg of [
      "[Instagram] CWqAgUZgCku: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is not, then use --cookies-from-browser or --cookies for the authentication.",
      "[youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      "[generic] Unable to download webpage: HTTP Error 403: Forbidden",
      "[vimeo] 123: This video is private",
      "Join this channel to get access to members-only content",
      "This content may be inappropriate. Sign in to confirm your age",
    ]) {
      expect(needsSession(msg), msg.slice(0, 40)).toBe(true);
    }
    for (const msg of [
      "Unsupported URL: https://www.instagram.com/",
      "[generic] Unable to download webpage: HTTP Error 404: Not Found",
      "Requested format is not available",
      "Unable to extract video url",
    ]) {
      expect(needsSession(msg), msg.slice(0, 40)).toBe(false);
    }
  });

  it("converts browser cookies and drops the ones the host would refuse", () => {
    const base = { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, name: "sessionid", value: "a%3Ab", session: false, expirationDate: 1893456000.5 };
    expect(toSessionCookie(base)).toEqual({
      domain: ".instagram.com", hostOnly: false, path: "/", secure: true, name: "sessionid", value: "a%3Ab", expires: 1893456000,
    });
    expect(toSessionCookie({ ...base, session: true })?.expires).toBeUndefined();
    expect(toSessionCookie({ ...base, value: `a${String.fromCharCode(9)}b` })).toBeNull();
    expect(toSessionCookie({ ...base, value: `a${String.fromCharCode(10)}b` })).toBeNull();
    expect(toSessionCookie({ ...base, name: "bad name" })).toBeNull();
    expect(toSessionCookie({ ...base, value: "x".repeat(5000) })).toBeNull();
  });
});

// ---------------------------------------------------------------- texts when Chrome gives a page none

describe("texts of the extension's own pages", () => {
  it("come from the bundled catalog, in the browser's language, when chrome.i18n answers nothing", () => {
    useBundledMessages({ en: enMessages, es: esMessages });
    try {
      vi.stubGlobal("chrome", { i18n: { getMessage: () => "", getUILanguage: () => "es-ES" } });
      expect(t("recStateRecording")).toBe("Grabando");
      expect(t("fileN", "2")).toBe("Fichero 2");
      vi.stubGlobal("chrome", { i18n: { getMessage: () => "", getUILanguage: () => "en-US" } });
      expect(t("recStateRecording")).toBe("Recording");
      expect(t("recLost", ["3"])).toMatch(/^3 fragments/);
      // Chrome's own answer wins whenever there is one; an unknown key stays a key.
      vi.stubGlobal("chrome", { i18n: { getMessage: (k: string) => (k === "recStateRecording" ? "Grabando ahora" : ""), getUILanguage: () => "en-US" } });
      expect(t("recStateRecording")).toBe("Grabando ahora");
      expect(t("noSuchKey")).toBe("noSuchKey");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------- audio of each quality

describe("HLS audio paired with each quality", () => {
  it("uses the audio group each variant names (X gives 32, 64 and 128 kbps)", () => {
    const url = "https://video.twimg.com/amplify_video/2039532852929310720/pl/efX7irkUSKsFtEqx.m3u8?tag=21&v=59e";
    const variants = hlsVariants(fixture("x-master-audio-groups.m3u8"), url, 30);
    const audioOf = (label: string) => variants.find((v) => v.label === label)?.manifestQuality?.audioPlaylistUrl ?? "";
    expect(variants.map((v) => v.label)).toEqual(["2160p", "1080p", "720p", "360p", "270p"]);
    expect(audioOf("720p")).toMatch(/\/mp4a\/128000\//);
    expect(audioOf("1080p")).toMatch(/\/mp4a\/128000\//);
    expect(audioOf("360p")).toMatch(/\/mp4a\/64000\//);
    expect(audioOf("270p")).toMatch(/\/mp4a\/32000\//);
  });
});
