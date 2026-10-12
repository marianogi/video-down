import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { route, youtubeWatchUrl, isManifestUrl, BLOB_GRACE_MS, type RouteInput } from "../src/core/router";
import { bindMedia, BINDING_WINDOW_MS } from "../src/core/binding";
import { hlsVariants, dashVariants } from "../src/core/variants";
import { detectHlsDrm, detectDashDrm, canDecrypt } from "../src/core/utils/drm-utils";
import { resolveSettings } from "../src/core/storage/settings";
import { VideoFormat, type VideoMetadata } from "../src/core/types";

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
