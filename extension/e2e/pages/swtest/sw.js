// Service worker of the e2e page swtest/sw.html: it fetches the HLS playlists itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const path = new URL(event.request.url).pathname;
  if (path.startsWith("/media/hls/") && path.endsWith(".m3u8")) event.respondWith(fetch(event.request));
});
