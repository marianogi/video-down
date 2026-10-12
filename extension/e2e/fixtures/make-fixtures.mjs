// Generate the media used by the end-to-end tests into e2e/fixtures/media (git-ignored).
// Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg). Usage: node e2e/fixtures/make-fixtures.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "media");
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const SECONDS = 6;

function run(args, cwd = out) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd, stdio: "inherit" });
}

const source = (w, h) => [
  "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=25:duration=${SECONDS}`,
  "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
];
const h264 = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "50", "-c:a", "aac", "-b:a", "96k"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Plain files
run([...source(640, 360), ...h264, "-movflags", "+faststart", "clip-360.mp4"]);
run([...source(1280, 720), ...h264, "-movflags", "+faststart", "clip-720.mp4"]);

// 2. HLS with two muxed variants and a master playlist
for (const [w, h, br] of [[640, 360, "600k"], [1280, 720, "1800k"]]) {
  const dir = join(out, "hls", `v${h}`);
  mkdirSync(dir, { recursive: true });
  run([...source(w, h), ...h264, "-b:v", br, "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
    "-hls_segment_filename", "seg%03d.ts", "index.m3u8"], dir);
}
writeFileSync(join(out, "hls", "master.m3u8"), [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"',
  "v360/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
  "v720/index.m3u8",
  "",
].join("\n"));

// 3. HLS encrypted with AES-128 (clear key published in the playlist: NOT DRM)
{
  const dir = join(out, "hls-aes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "enc.key"), randomBytes(16));
  writeFileSync(join(dir, "key_info"), `enc.key\n${join(dir, "enc.key")}\n${randomBytes(16).toString("hex")}\n`);
  run([...source(640, 360), ...h264, "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
    "-hls_key_info_file", "key_info", "-hls_segment_filename", "seg%03d.ts", "index.m3u8"], dir);
}

// 3b. AES-128 WITHOUT an IV attribute: the IV is the media sequence number (RFC 8216 §5.2).
//     This is what many CDNs serve; Media Bridge stored such segments still encrypted.
{
  const dir = join(out, "hls-aes-noiv");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "enc.key"), randomBytes(16));
  writeFileSync(join(dir, "key_info"), `enc.key
${join(dir, "enc.key")}
`);
  run([...source(640, 360), ...h264, "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
    "-start_number", "5", "-hls_key_info_file", "key_info", "-hls_segment_filename", "seg%03d.ts", "index.m3u8"], dir);
  // ffmpeg writes IV=<sequence number> explicitly; CDNs usually omit it, which per RFC 8216
  // means exactly that value. Remove it to reproduce what those CDNs serve.
  const text = readFileSync(join(dir, "index.m3u8"), "utf8").replace(/,IV=0x[0-9a-fA-F]+/g, "");
  writeFileSync(join(dir, "index.m3u8"), text);
  if (/IV=/.test(text) || !/METHOD=AES-128/.test(text)) throw new Error("expected AES-128 without IV");
}

// 3c. AES-128 with an explicit IV whose 32-bit words start with zero bytes
//     (Media Bridge wrote each word with 2 hex digits instead of 8 and broke the IV).
{
  const dir = join(out, "hls-aes-zeroiv");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "enc.key"), randomBytes(16));
  writeFileSync(join(dir, "key_info"), `enc.key
${join(dir, "enc.key")}
0000000a000000000000ab0000000001
`);
  run([...source(640, 360), ...h264, "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
    "-hls_key_info_file", "key_info", "-hls_segment_filename", "seg%03d.ts", "index.m3u8"], dir);
}

// 3d. Whole stream in ONE file, segments addressed with EXT-X-BYTERANGE.
{
  const dir = join(out, "hls-byterange");
  mkdirSync(dir, { recursive: true });
  run([...source(640, 360), ...h264, "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
    "-hls_flags", "single_file", "index.m3u8"], dir);
  const text = readFileSync(join(dir, "index.m3u8"), "utf8");
  if (!/#EXT-X-BYTERANGE/.test(text)) throw new Error("expected EXT-X-BYTERANGE");
}

// 3e. Corrupt segments (valid playlist, garbage media) to exercise the native fallback.
{
  const dir = join(out, "hls-garbage");
  mkdirSync(dir, { recursive: true });
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", "#EXT-X-PLAYLIST-TYPE:VOD"];
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(dir, `seg${i}.ts`), randomBytes(64 * 1024));
    lines.push("#EXTINF:2.0,", `seg${i}.ts`);
  }
  lines.push("#EXT-X-ENDLIST", "");
  writeFileSync(join(dir, "index.m3u8"), lines.join(String.fromCharCode(10)));
}

// 4. DASH with two video representations and separate audio
{
  const dir = join(out, "dash");
  mkdirSync(dir, { recursive: true });
  run([
    "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25:duration=${SECONDS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
    "-map", "0:v", "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0",
    "-b:v:0", "1500k", "-s:v:0", "1280x720",
    "-b:v:1", "500k", "-s:v:1", "640x360",
    "-c:a", "aac", "-b:a", "96k",
    "-f", "dash", "-seg_duration", "2", "-use_template", "1", "-use_timeline", "0",
    "-adaptation_sets", "id=0,streams=v id=1,streams=a",
    "manifest.mpd",
  ], dir);
}

// 5. DASH manifest that declares Widevine (only the manifest matters for the test)
{
  const { readFileSync } = await import("node:fs");
  const mpd = readFileSync(join(out, "dash", "manifest.mpd"), "utf8").replace(
    /<AdaptationSet([^>]*contentType="video"[^>]*)>/,
    '<AdaptationSet$1>\n      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh xmlns:cenc="urn:mpeg:cenc:2013">AAAAW3Bzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAADsIARIQ</cenc:pssh></ContentProtection>',
  );
  if (!mpd.includes("ContentProtection")) throw new Error("could not inject ContentProtection");
  writeFileSync(join(out, "dash", "widevine.mpd"), mpd);
}

for (const f of ["clip-360.mp4", "hls/master.m3u8", "hls-aes/index.m3u8", "hls-aes-noiv/index.m3u8",
  "hls-aes-zeroiv/index.m3u8", "hls-byterange/index.m3u8", "hls-garbage/index.m3u8", "dash/manifest.mpd", "dash/widevine.mpd"]) {
  if (!existsSync(join(out, f))) throw new Error(`missing ${f}`);
}
console.log(`fixtures ready in ${out}`);
