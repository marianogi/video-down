// Tiny static server for the e2e pages and media (with Range support and correct MIME types).
//
// Special routes that reproduce real-world CDNs:
//   /media/hls/playlist  HLS master without a .m3u8 extension (Content-Type detection)
//   /protected/hls/...   HLS that answers 403 unless the Referer is the player's origin
//                        (common with players embedded from another site)
//   /odd/hls/...         HLS served as text/plain, master without extension (body sniffing)
//   /once/master.m3u8?token=…  single-use link: the first request gets the playlist, any repeat a 403
//   /once/…              the variants and segments of that master (no token needed)
//   /opaque/master.m3u8  "playlist" that is not HLS (encrypted bytes), served as mpegurl
//   /live/master.m3u8    a live stream: its playlist (/live/v360.m3u8) advances with the clock,
//                        2 s per segment, looping over fixtures/media/live with a discontinuity
//   /liveg/…             the same live stream, but its playlist (/liveg/v360.m3u8) only answers the
//                        player, which sends "x-player: 1" (403 otherwise), as many live CDNs do
//   /htmllive/stream     the same live playlist, without extension and served as text/html, as some
//                        live CDNs hide it
//   /redir/hls/…         the HLS fixture, but each segment answers 302 to the same segment on another
//                        host (localhost vs 127.0.0.1) that demands the player's Referer, as CDNs that
//                        hand segments to another server do
//   /liveredir/…         the same with the live stream: its segments redirect to /livesecure/ on the
//                        other host, which demands the player's Referer
//   /session/…           only with the cookie vdsession=ok (403 otherwise), like a site behind a
//                        login: post.html is a post page with its video, clip.mp4 that video
//   /media/uni/*.m3u8    Unified Origin names; playlists answer 403 without ?token=abc, and the
//                        master (clip.m3u8) answers 1.5 s late
//   /slowhead/*          the files of /media/, but a HEAD request (how the extension asks a file's
//                        size) answers 3 s late; /slowhead-count says how many HEAD requests came
//   /protected/hls/cross-master.m3u8
//                        master whose variants and segments live on ANOTHER host (localhost vs
//                        127.0.0.1), all of them requiring the player's Referer
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".ts": "video/mp2t",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".mpd": "application/dash+xml",
  ".key": "application/octet-stream",
};

const usedTokens = new Set();
let slowHeads = 0;
const LIVE_START = Date.now();
const LIVE_LOOP = 15; // segments in fixtures/media/live
const LIVE_WINDOW = 6;

function livePlaylist() {
  const now = Math.floor((Date.now() - LIVE_START) / 2000) + LIVE_WINDOW;
  const first = now - LIVE_WINDOW + 1;
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${first}`];
  for (let seq = first; seq <= now; seq++) {
    if (seq % LIVE_LOOP === 0) lines.push("#EXT-X-DISCONTINUITY");
    lines.push("#EXTINF:2.000,", `seg/${seq}.ts`);
  }
  return lines.join("\n") + "\n";
}

export function startServer(port = 0) {
  const server = createServer((req, res) => {
    // The master next to a lone variant answers late, so the menu is already open with that one
    // quality when the master is found (as on a slow machine or CDN).
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/media/uni/clip.m3u8") {
      setTimeout(() => handle(req, res), 1500);
      return;
    }
    // A slow size lookup: the menu opened right after hovering must already have it.
    if (pathname.startsWith("/slowhead/") && req.method === "HEAD") {
      slowHeads++;
      setTimeout(() => handle(req, res), 3000);
      return;
    }
    if (pathname === "/slowhead-count") {
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(String(slowHeads));
      return;
    }
    handle(req, res);
  });

  function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const playerOrigin = `http://127.0.0.1:${server.address().port}`;
    let pathname = url.pathname;
    let type;

    if (pathname === "/once/master.m3u8") {
      const token = url.searchParams.get("token") ?? "";
      if (usedTokens.has(token)) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("token already used");
        return;
      }
      usedTokens.add(token);
      pathname = "/media/hls/master.m3u8";
    } else if (pathname.startsWith("/redir/hls/") && pathname.endsWith(".ts")) {
      res.writeHead(302, { Location: `http://localhost:${server.address().port}${pathname.replace("/redir/hls/", "/protected/hls/")}` }).end();
      return;
    } else if (pathname.startsWith("/redir/hls/")) {
      pathname = pathname.replace("/redir/hls/", "/media/hls/");
    } else if (/^\/liveredir\/seg\/\d+\.ts$/.test(pathname)) {
      res.writeHead(302, { Location: `http://localhost:${server.address().port}${pathname.replace("/liveredir/", "/livesecure/")}`, "Cache-Control": "no-store" }).end();
      return;
    } else if (pathname.startsWith("/livesecure/") && !(req.headers.referer ?? "").startsWith(`${playerOrigin}/`)) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden: bad referer");
      return;
    } else if (pathname === "/htmllive/stream") {
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" }).end(livePlaylist());
      return;
    } else if (/^\/(live|liveg|liveredir|livesecure)\//.test(pathname) || pathname.startsWith("/htmllive/seg/")) {
      const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
      pathname = pathname.replace(/^\/(htmllive|liveredir|livesecure)\//, "/live/");
      const guarded = pathname.startsWith("/liveg/");
      pathname = pathname.replace(/^\/liveg\//, "/live/");
      if (guarded && pathname === "/live/v360.m3u8" && req.headers["x-player"] !== "1") {
        res.writeHead(403, { ...cors, "Content-Type": "text/plain" }).end("only the player");
        return;
      }
      if (pathname === "/live/master.m3u8") {
        res.writeHead(200, { ...cors, "Content-Type": TYPES[".m3u8"] }).end(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\nv360.m3u8\n',
        );
        return;
      }
      if (pathname === "/live/v360.m3u8") {
        res.writeHead(200, { ...cors, "Content-Type": TYPES[".m3u8"] }).end(livePlaylist());
        return;
      }
      const m = pathname.match(/^\/live\/seg\/(\d+)\.ts$/);
      if (!m) {
        res.writeHead(404).end("not found");
        return;
      }
      pathname = `/media/live/seg${String(Number(m[1]) % LIVE_LOOP).padStart(3, "0")}.ts`;
    } else if (pathname.startsWith("/session/")) {
      if (!/(?:^|;\s*)vdsession=ok(?:;|$)/.test(req.headers.cookie ?? "")) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden: log in first");
        return;
      }
      if (pathname === "/session/post.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
          '<!doctype html><html><head><meta charset="utf-8"><title>¡Members post, ñandú! «test»</title></head>' +
            '<body><h1>Members post</h1><video controls src="/session/clip.mp4"></video></body></html>',
        );
        return;
      }
      if (pathname === "/session/clip.mp4") pathname = "/media/clip-360.mp4";
    } else if (pathname.startsWith("/once/")) {
      pathname = pathname.replace("/once/", "/media/hls/");
    } else if (pathname.startsWith("/slowhead/")) {
      pathname = pathname.replace("/slowhead/", "/media/");
    } else if (pathname.startsWith("/media/uni/") && pathname.endsWith(".m3u8") && url.searchParams.get("token") !== "abc") {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden: missing token");
      return;
    } else if (pathname === "/opaque/master.m3u8") {
      const bytes = Buffer.alloc(512);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 73 + 41) % 256;
      res.writeHead(200, { "Content-Type": TYPES[".m3u8"], "Access-Control-Allow-Origin": "*" }).end(bytes);
      return;
    } else if (pathname.startsWith("/protected/")) {
      const referer = req.headers.referer ?? "";
      if (!referer.startsWith(`${playerOrigin}/`)) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden: bad referer");
        return;
      }
      if (pathname === "/protected/hls/cross-master.m3u8") {
        const other = `http://localhost:${server.address().port}/protected/hls/`;
        const body = readFileSync(join(root, "fixtures/media/hls/master.m3u8"), "utf8").replace(
          /^(v\d+\/index\.m3u8)$/gm,
          (rel) => other + rel,
        );
        res.writeHead(200, { "Content-Type": TYPES[".m3u8"], "Access-Control-Allow-Origin": "*" }).end(body);
        return;
      }
      pathname = pathname.replace("/protected/", "/media/");
    } else if (pathname.startsWith("/odd/")) {
      pathname = pathname.replace("/odd/", "/media/");
      if (pathname === "/media/hls/master") pathname = "/media/hls/master.m3u8";
      if (pathname.endsWith(".m3u8")) type = "text/plain; charset=utf-8";
    }
    if (pathname === "/media/hls/playlist") {
      pathname = "/media/hls/master.m3u8";
      type = TYPES[".m3u8"];
    }

    // /media/... → fixtures/media, everything else → pages
    let path = pathname.startsWith("/media/")
      ? join(root, "fixtures", pathname)
      : join(root, "pages", pathname === "/" ? "index.html" : pathname);
    path = normalize(path);
    if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const size = statSync(path).size;
    type ??= TYPES[extname(path)] ?? "application/octet-stream";
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") return res.end();
    createReadStream(path).pipe(res);
  }
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = await startServer(Number(process.env.PORT || 8765));
  console.log(`e2e server on http://127.0.0.1:${server.address().port}/`);
}
