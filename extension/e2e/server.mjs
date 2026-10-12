// Tiny static server for the e2e pages and media (with Range support and correct MIME types).
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
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

export function startServer(port = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    // /media/... → fixtures/media, everything else → pages
    let path = url.pathname.startsWith("/media/")
      ? join(root, "fixtures", url.pathname)
      : join(root, "pages", url.pathname === "/" ? "index.html" : url.pathname);
    // "/playlist" serves the HLS master without a .m3u8 extension (same folder, so relative variant URIs still resolve) (Content-Type detection test)
    if (url.pathname === "/media/hls/playlist") path = join(root, "fixtures/media/hls/master.m3u8");
    path = normalize(path);
    if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const size = statSync(path).size;
    const type = TYPES[extname(path)] ?? (url.pathname === "/media/hls/playlist" ? TYPES[".m3u8"] : "application/octet-stream");
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
