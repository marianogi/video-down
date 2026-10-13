import { assert, assertEquals, assertThrows } from "./assert.ts";
import { cookieFileText, cookieMatchesUrl, parseCookies, parseRequest, isSafeHttpUrl } from "../src/protocol.ts";
import { buildVariants, publicVariants, selectorForHeight } from "../src/variants.ts";
import { parseProgressLine, ProgressTracker, summariseError } from "../src/progress.ts";
import { encodeMessage, FrameDecoder, MAX_INCOMING_BYTES } from "../src/messaging.ts";

// ---------------------------------------------------------------- protocol

Deno.test("isSafeHttpUrl accepts http(s) and rejects everything else", () => {
  assert(isSafeHttpUrl("https://www.youtube.com/watch?v=abc"));
  assert(isSafeHttpUrl("http://example.com/a.m3u8"));
  for (const bad of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://x.org/a",
    "-o/tmp/x",
    "https://exa mple.com",
    "https://user:pass@example.com/",
    "https://example.com/\nfoo",
    "",
    "x".repeat(5000),
    42,
    null,
  ]) {
    assert(!isSafeHttpUrl(bad), `should reject ${String(bad).slice(0, 40)}`);
  }
});

Deno.test("parseRequest validates every message type", () => {
  assertEquals(parseRequest({ id: "a1", type: "ping" }), { ok: true, value: { id: "a1", type: "ping" } });
  const probe = parseRequest({ id: "a2", type: "probe", url: "https://x.org/v", referer: "https://x.org/" });
  assert(probe.ok && probe.value.type === "probe" && probe.value.referer === "https://x.org/");
  assert(!parseRequest({ id: "a3", type: "probe", url: "file:///c:/x" }).ok);
  assert(!parseRequest({ id: "a4", type: "probe", url: "https://x.org", referer: "chrome://settings" }).ok);
  assert(parseRequest({ id: "a5", type: "download", probeId: "abc123", variantId: "h1080" }).ok);
  assert(!parseRequest({ id: "a6", type: "download", probeId: "../../etc", variantId: "h1080" }).ok);
  assert(!parseRequest({ id: "a7", type: "download", probeId: "abc", variantId: "h1080 --exec rm" }).ok);
  assert(!parseRequest({ id: "bad id!", type: "ping" }).ok);
  assert(!parseRequest({ id: "a8", type: "exec", cmd: "calc" }).ok);
  assert(!parseRequest([1, 2]).ok);
  assert(!parseRequest("ping").ok);
});

// ---------------------------------------------------------------- variants

const youtubeLike = {
  id: "aqz-KE-bpKQ",
  title: "Big Buck Bunny 60fps 4K",
  extractor_key: "Youtube",
  duration: 635,
  is_live: false,
  formats: [
    { format_id: "sb0", vcodec: "none", acodec: "none", ext: "mhtml", format_note: "storyboard" },
    { format_id: "139", vcodec: "none", acodec: "mp4a.40.5", ext: "m4a", tbr: 48, filesize: 3_800_000 },
    { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", tbr: 129, filesize: 10_300_000 },
    { format_id: "251", vcodec: "none", acodec: "opus", ext: "webm", tbr: 140, filesize: 11_000_000 },
    { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, width: 640, fps: 30, ext: "mp4", tbr: 500 },
    { format_id: "134", vcodec: "avc1.4d401e", acodec: "none", height: 360, width: 640, fps: 60, tbr: 400, filesize: 30_000_000 },
    { format_id: "298", vcodec: "avc1.4d4020", acodec: "none", height: 720, width: 1280, fps: 60, tbr: 2500, filesize: 190_000_000 },
    { format_id: "302", vcodec: "vp09.00.40.08", acodec: "none", height: 720, width: 1280, fps: 60, tbr: 2200, filesize: 170_000_000 },
    { format_id: "299", vcodec: "avc1.64002a", acodec: "none", height: 1080, width: 1920, fps: 60, tbr: 4500, filesize: 350_000_000 },
    { format_id: "399", vcodec: "av01.0.09M.08", acodec: "none", height: 1080, width: 1920, fps: 60, tbr: 2900 },
    { format_id: "315", vcodec: "vp9", acodec: "none", height: 2160, width: 3840, fps: 60, tbr: 18000, filesize_approx: 1_400_000_000 },
    { format_id: "401", vcodec: "av01.0.13M.08", acodec: "none", height: 2160, width: 3840, fps: 60, tbr: 12000 },
    { format_id: "drm1", vcodec: "avc1", acodec: "none", height: 4320, has_drm: true },
  ],
};

Deno.test("buildVariants groups by height, prefers H.264 and adds AAC size", () => {
  const built = buildVariants(youtubeLike);
  assertEquals(built.drm, false);
  assertEquals(built.isLive, false);
  assertEquals(built.variants.map((v) => v.id), ["h2160", "h1080", "h720", "h360"]);
  const v1080 = built.variants.find((v) => v.id === "h1080")!;
  assertEquals(v1080.vcodec, "H.264");
  assertEquals(v1080.label, "1080p60");
  assertEquals(v1080.approxBytes, 350_000_000 + 10_300_000);
  const v2160 = built.variants.find((v) => v.id === "h2160")!;
  assertEquals(v2160.vcodec, "VP9");
  assertEquals(v2160.selector, selectorForHeight(2160));
  // the DRM-only 4320p format is never offered
  assert(!built.variants.some((v) => v.height === 4320));
});

Deno.test("publicVariants never leaks the yt-dlp selector", () => {
  const pub = publicVariants(buildVariants(youtubeLike).variants);
  assert(pub.every((v) => !("selector" in v)));
});

Deno.test("buildVariants flags DRM-only and live media without variants", () => {
  const drm = buildVariants({ title: "x", formats: [{ vcodec: "avc1", height: 720, has_drm: true }] });
  assertEquals(drm.drm, true);
  assertEquals(drm.variants, []);
  const live = buildVariants({ title: "x", is_live: true, formats: [{ vcodec: "avc1", height: 720 }] });
  assertEquals(live.isLive, true);
  assertEquals(live.variants, []);
});

Deno.test("buildVariants falls back to a single 'best' variant", () => {
  const built = buildVariants({ title: "clip", formats: [{ format_id: "0", vcodec: "unknown", acodec: "mp3" }] });
  assertEquals(built.variants.map((v) => v.id), ["best"]);
});

Deno.test("selectorForHeight only interpolates an integer", () => {
  const s = selectorForHeight(1080.9);
  assert(s.includes("[height=1080]"));
  assert(!s.includes("1080.9"));
  assert(s.endsWith("/b"));
});

// ---------------------------------------------------------------- progress

Deno.test("parseProgressLine reads yt-dlp's template output", () => {
  assertEquals(parseProgressLine("VDPROG downloading|1048576|4194304|NA|524288.5|6"), {
    status: "downloading",
    downloaded: 1048576,
    total: 4194304,
    speed: 524288.5,
    eta: 6,
  });
  assertEquals(parseProgressLine("VDPROG downloading|100|NA|400|NA|NA"), {
    status: "downloading",
    downloaded: 100,
    total: 400,
  });
  assertEquals(parseProgressLine("[download] 10%"), null);
});

Deno.test("ProgressTracker spreads progress across video and audio parts", () => {
  const t = new ProgressTracker();
  t.setFormatIds("299+140");
  assertEquals(t.update({ status: "downloading", downloaded: 50, total: 100 }), 25);
  assertEquals(t.update({ status: "finished" }), 50);
  assertEquals(t.update({ status: "finished" }), 50); // duplicate "finished" is ignored
  assertEquals(t.update({ status: "downloading", downloaded: 100, total: 100 }), 100);
  t.update({ status: "finished" });
  assert(t.allPartsFinished());
});

Deno.test("summariseError picks the last ERROR line", () => {
  const stderr = "WARNING: foo\nERROR: [youtube] abc: Video unavailable\n";
  assertEquals(summariseError(stderr), "[youtube] abc: Video unavailable");
});

// ---------------------------------------------------------------- framing

Deno.test("FrameDecoder handles split and concatenated frames", () => {
  const a = encodeMessage({ id: "1", type: "ping" });
  const b = encodeMessage({ id: "2", type: "ping" });
  const both = new Uint8Array([...a, ...b]);
  const d = new FrameDecoder();
  assertEquals(d.push(both.subarray(0, 3)), []);
  assertEquals(d.push(both.subarray(3, a.length + 2)), [{ id: "1", type: "ping" }]);
  assertEquals(d.push(both.subarray(a.length + 2)), [{ id: "2", type: "ping" }]);
});

Deno.test("FrameDecoder rejects oversized frames", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_INCOMING_BYTES + 1, true);
  assertThrows(() => new FrameDecoder().push(header));
});

// ---------------------------------------------------------------- session cookies

const igCookie = { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, name: "sessionid", value: "abc%3A1" };

Deno.test("cookies only for the site being downloaded", () => {
  assert(cookieMatchesUrl(igCookie, "https://www.instagram.com/reel/X/"));
  assert(cookieMatchesUrl(igCookie, "https://instagram.com/p/X/"));
  assert(!cookieMatchesUrl(igCookie, "https://evil-instagram.com/"));
  assert(!cookieMatchesUrl(igCookie, "https://example.com/"));
  const hostOnly = { domain: "www.example.com", hostOnly: true };
  assert(cookieMatchesUrl(hostOnly, "https://www.example.com/a"));
  assert(!cookieMatchesUrl(hostOnly, "https://cdn.www.example.com/a"));
});

Deno.test("parseCookies refuses anything that could forge a line of the cookie file", () => {
  assert(parseCookies([igCookie], "https://www.instagram.com/p/X/").ok);
  for (const bad of [
    { ...igCookie, value: "a\tb" },
    { ...igCookie, value: "a\nexample.com\tTRUE\t/\tFALSE\t0\tx\ty" },
    { ...igCookie, name: "a b" },
    { ...igCookie, domain: "insta gram.com" },
    { ...igCookie, path: "relative" },
    { ...igCookie, value: "x".repeat(5000) },
    { ...igCookie, expires: -1 },
    { ...igCookie, secure: "yes" },
  ]) {
    assert(!parseCookies([bad], "https://www.instagram.com/p/X/").ok, JSON.stringify(bad).slice(0, 60));
  }
  const other = parseCookies([igCookie], "https://example.com/");
  assert(!other.ok && other.reason === "cookie for another site");
  assert(!parseCookies([], "https://www.instagram.com/").ok);
  assert(!parseCookies(Array(201).fill(igCookie), "https://www.instagram.com/").ok);
});

Deno.test("parseRequest carries cookies on probes and downloads", () => {
  const probe = parseRequest({ id: "a", type: "probe", url: "https://www.instagram.com/p/X/", cookies: [igCookie] });
  assert(probe.ok && probe.value.type === "probe" && probe.value.cookies?.length === 1);
  const wrongSite = parseRequest({ id: "a", type: "probe", url: "https://example.com/", cookies: [igCookie] });
  assert(!wrongSite.ok);
  const download = parseRequest({ id: "b", type: "download", probeId: "p1", variantId: "best", cookies: [igCookie] });
  assert(download.ok && download.value.type === "download" && download.value.cookies?.length === 1);
  assert(!parseRequest({ id: "b", type: "download", probeId: "p1", variantId: "best", cookies: [{ ...igCookie, value: "a\nb" }] }).ok);
});

Deno.test("cookieFileText writes the Netscape format yt-dlp reads", () => {
  const text = cookieFileText(
    [igCookie, { domain: "www.example.com", hostOnly: true, path: "/x", secure: false, name: "k", value: "v", expires: 2000000000 }],
    1000,
  );
  const lines = text.trimEnd().split("\n");
  assertEquals(lines[0], "# Netscape HTTP Cookie File");
  assertEquals(lines[2], [".instagram.com", "TRUE", "/", "TRUE", "87400", "sessionid", "abc%3A1"].join("\t"));
  assertEquals(lines[3], ["www.example.com", "FALSE", "/x", "FALSE", "2000000000", "k", "v"].join("\t"));
});
