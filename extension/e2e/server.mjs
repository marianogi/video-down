// Tiny static server for the e2e pages and media (with Range support and correct MIME types).
//
// Special routes that reproduce real-world CDNs:
//   /media/hls/playlist  HLS master without a .m3u8 extension (Content-Type detection)
//   /protected/hls/...   HLS that answers 403 unless the Referer is the player's origin
//                        (common with players embedded from another site)
//   /odd/hls/...         HLS served as text/plain, master without extension (body sniffing)
//   /once/master.m3u8?token=…  single-use link: the first request gets the playlist, any repeat a 403
//   /opaque/master.m3u8  "playlist" that is not HLS (encrypted bytes), served as mpegurl
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

export function startServer(port = 0) {
  const server = createServer((req, res) => {
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
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = await startServer(Number(process.env.PORT || 8765));
  console.log(`e2e server on http://127.0.0.1:${server.address().port}/`);
}
