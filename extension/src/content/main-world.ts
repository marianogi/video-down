/**
 * Runs in the page's MAIN world at document_start (declared in manifest.json).
 *
 * 1. DRM: notices when a <video> uses Encrypted Media Extensions (Widevine,
 *    PlayReady, FairPlay, ClearKey) so the overlay can warn that the video is
 *    DRM-protected. It never touches keys, licences or media data.
 *    It marks the element with `data-video-down-drm="<key system>"` and dispatches
 *    a `video-down:drm` event on it.
 *
 * 2. Playlists recognised by content: some sites serve HLS/DASH playlists with
 *    URLs and Content-Types that say nothing (".../master", "text/plain"). When the
 *    page's fetch/XHR receives a small text body starting like a playlist, the URL
 *    is reported with a `video-down:manifest` event. The extension only accepts it
 *    after checking that the page really requested that URL.
 *
 * Wrappers are Proxies so `Function.prototype.toString` still reports native
 * code and pages that inspect these APIs keep working.
 */

(() => {
  const FLAG = "__videoDownEmeProbe";
  const w = window as unknown as Record<string, unknown>;
  if (w[FLAG]) return;
  w[FLAG] = true;

  // ------------------------------------------------------------------ DRM (EME)

  const ATTR = "data-video-down-drm";
  const keySystems = new WeakMap<object, string>();

  function mark(target: EventTarget | null, keySystem: string): void {
    if (!(target instanceof HTMLMediaElement)) return;
    if (target.getAttribute(ATTR) === keySystem) return;
    try {
      target.setAttribute(ATTR, keySystem);
      target.dispatchEvent(
        new CustomEvent("video-down:drm", { detail: keySystem, bubbles: true, composed: true }),
      );
    } catch {
      // never break the page
    }
  }

  // MediaKeySystemAccess → keySystem, so setMediaKeys() can report which one.
  try {
    const access = window.MediaKeySystemAccess?.prototype;
    if (access && typeof access.createMediaKeys === "function") {
      access.createMediaKeys = new Proxy(access.createMediaKeys, {
        apply(target, thisArg: MediaKeySystemAccess, args) {
          const result = Reflect.apply(target, thisArg, args) as Promise<MediaKeys>;
          return result.then((mediaKeys) => {
            try {
              keySystems.set(mediaKeys, thisArg.keySystem);
            } catch {
              // ignore
            }
            return mediaKeys;
          });
        },
      });
    }
  } catch {
    // ignore
  }

  // The strongest signal: the element gets a MediaKeys instance.
  try {
    const media = HTMLMediaElement.prototype;
    if (typeof media.setMediaKeys === "function") {
      media.setMediaKeys = new Proxy(media.setMediaKeys, {
        apply(target, thisArg: HTMLMediaElement, args: [MediaKeys | null]) {
          const mediaKeys = args[0];
          if (mediaKeys) mark(thisArg, keySystems.get(mediaKeys) ?? "EME");
          return Reflect.apply(target, thisArg, args);
        },
      });
    }
  } catch {
    // ignore
  }

  // Encrypted init data seen by the element (fires even before keys are set).
  // `encrypted` does not bubble, but capturing listeners on the document see it.
  document.addEventListener(
    "encrypted",
    (event) => mark(event.target, (event.target as HTMLElement)?.getAttribute?.(ATTR) || "EME"),
    true,
  );

  // ------------------------------------------------------------------ playlists by content

  const MAX_SNIFF_BYTES = 2 * 1024 * 1024;
  const reported = new Set<string>();

  function kindOf(text: string): "hls" | "dash" | null {
    const head = text.slice(0, 512).trimStart();
    if (head.startsWith("#EXTM3U")) return "hls";
    if (/^(?:<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(head)) return "dash";
    return null;
  }

  function report(url: string, text: string): void {
    const kind = kindOf(text);
    if (!kind || reported.has(url) || !/^https?:/i.test(url)) return;
    reported.add(url);
    document.dispatchEvent(new CustomEvent("video-down:manifest", { detail: JSON.stringify({ url, kind }) }));
  }

  /** Bodies worth a look: text-like, small, and not obviously something else. */
  function worthSniffing(contentType: string | null, length: string | null): boolean {
    const ct = (contentType || "").toLowerCase();
    if (/mpegurl|dash\+xml/.test(ct)) return false; // the service worker already recognises these
    if (/^(video|audio|image|font)\/|json|javascript|css|html|protobuf|grpc|wasm/.test(ct)) return false;
    const n = Number(length);
    return !(Number.isFinite(n) && n > MAX_SNIFF_BYTES);
  }

  try {
    const originalFetch = window.fetch;
    window.fetch = new Proxy(originalFetch, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        const promise = Reflect.apply(target, thisArg, args) as Promise<Response>;
        promise
          .then((response) => {
            if (!response.ok || !worthSniffing(response.headers.get("content-type"), response.headers.get("content-length"))) return;
            // Read only the first chunk of a copy and cancel it: the head is enough to recognise
            // a playlist, and streaming responses (chat, event streams) are never buffered.
            const reader = response.clone().body?.getReader();
            if (!reader) return;
            reader
              .read()
              .then(({ value }) => {
                void reader.cancel().catch(() => undefined);
                if (value) report(response.url, new TextDecoder().decode(value.subarray(0, 1024)));
              })
              .catch(() => undefined);
          })
          .catch(() => undefined);
        return promise;
      },
    });
  } catch {
    // ignore
  }

  try {
    const proto = XMLHttpRequest.prototype;
    proto.send = new Proxy(proto.send, {
      apply(target, thisArg: XMLHttpRequest, args) {
        thisArg.addEventListener("load", () => {
          try {
            if (thisArg.status < 200 || thisArg.status >= 300) return;
            if (thisArg.responseType !== "" && thisArg.responseType !== "text") return;
            if (!worthSniffing(thisArg.getResponseHeader("content-type"), thisArg.getResponseHeader("content-length"))) return;
            report(thisArg.responseURL, thisArg.responseText.slice(0, 1024));
          } catch {
            // ignore
          }
        });
        return Reflect.apply(target, thisArg, args);
      },
    });
  } catch {
    // ignore
  }
})();
