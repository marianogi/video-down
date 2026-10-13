/**
 * Runs in the page's MAIN world at document_start (declared in manifest.json).
 *
 * 1. DRM: notices when a <video> uses Encrypted Media Extensions (Widevine,
 *    PlayReady, FairPlay, ClearKey) so the overlay can warn that the video is
 *    DRM-protected. It never touches keys, licences or media data.
 *    It marks the element with `data-video-down-drm="<key system>"` and dispatches
 *    a `video-down:drm` event on it.
 *
 * 2. Playlists as the player received them: when the page's fetch/XHR receives a
 *    text body that starts like an HLS or DASH playlist, its URL and text are reported
 *    with a `video-down:manifest` event. This recognises playlists whose URL and
 *    Content-Type say nothing (".../master", "text/plain"), and keeps a copy of links
 *    that cannot be read twice (single-use or short-lived tokens). The extension only
 *    accepts a report after checking that the page really requested that URL.
 *
 * 3. Address changes: reports History API navigations at once (`video-down:navigation`),
 *    so a video loaded right after an address change is known to be a new one.
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

  // ------------------------------------------------------------------ address changes

  // Single-page apps change the address with the History API and load the next video at once.
  // The extension polls the address, which notices the change up to a second late; this event
  // tells it at the moment it happens. (A page faking it only resets its own list of videos.)
  const navigated = () => {
    try {
      document.dispatchEvent(new CustomEvent("video-down:navigation"));
    } catch {
      // never break the page
    }
  };
  try {
    for (const name of ["pushState", "replaceState"] as const) {
      const proto = History.prototype;
      proto[name] = new Proxy(proto[name], {
        apply(target, thisArg, args) {
          const result = Reflect.apply(target, thisArg, args);
          navigated();
          return result;
        },
      });
    }
    window.addEventListener("popstate", navigated);
    window.addEventListener("hashchange", navigated);
  } catch {
    // ignore
  }

  // ------------------------------------------------------------------ playlists by content

  // Playlists are text and small; anything bigger is not read past its first bytes.
  const MAX_TEXT = 2 * 1024 * 1024;
  const reported = new Set<string>();

  function kindOf(text: string): "hls" | "dash" | null {
    const head = text.slice(0, 512).trimStart();
    if (head.startsWith("#EXTM3U")) return "hls";
    if (/^(?:<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(head)) return "dash";
    return null;
  }

  /** Tell the extension, with the text the player received when it is complete. */
  function report(url: string, text: string, complete: boolean): void {
    const kind = kindOf(text);
    if (!kind || reported.has(url) || !/^https?:/i.test(url)) return;
    if (reported.size > 2000) reported.clear();
    reported.add(url);
    const detail = complete && text.length <= MAX_TEXT ? { url, kind, text } : { url, kind };
    document.dispatchEvent(new CustomEvent("video-down:manifest", { detail: JSON.stringify(detail) }));
  }

  /** Bodies worth a look: playlists by type, or small text that says nothing about itself. */
  function worthSniffing(contentType: string | null, length: string | null): boolean {
    const ct = (contentType || "").toLowerCase();
    const n = Number(length);
    if (Number.isFinite(n) && n > MAX_TEXT) return false;
    if (/mpegurl|dash\+xml/.test(ct)) return true;
    return !/^(video|audio|image|font)\/|json|javascript|css|html|protobuf|grpc|wasm/.test(ct);
  }

  /**
   * Read a copy of a fetch() response. Its first bytes decide: anything that does not start
   * like a playlist is cancelled at once, so media, event streams and downloads are never
   * buffered. A playlist is read to the end (up to MAX_TEXT).
   */
  async function readCopy(response: Response): Promise<void> {
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let text = "";
    let checked = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) text += decoder.decode(value, { stream: true });
        if (!checked && (done || text.trimStart().length >= 16)) {
          checked = true;
          if (!kindOf(text)) {
            void reader.cancel().catch(() => undefined);
            return;
          }
        }
        if (text.length > MAX_TEXT) {
          void reader.cancel().catch(() => undefined);
          report(response.url, text, false);
          return;
        }
        if (done) break;
      }
      text += decoder.decode();
      report(response.url, text, true);
    } catch {
      // the page cancelled its request, or the body was not readable
    }
  }

  try {
    const originalFetch = window.fetch;
    window.fetch = new Proxy(originalFetch, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        const promise = Reflect.apply(target, thisArg, args) as Promise<Response>;
        promise
          .then((response) => {
            if (!response.ok || !worthSniffing(response.headers.get("content-type"), response.headers.get("content-length"))) return;
            void readCopy(response);
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
            if (!worthSniffing(thisArg.getResponseHeader("content-type"), thisArg.getResponseHeader("content-length"))) return;
            const type = thisArg.responseType;
            if (type === "" || type === "text") {
              report(thisArg.responseURL, thisArg.responseText, true);
            } else if (type === "arraybuffer" && thisArg.response instanceof ArrayBuffer) {
              const bytes = new Uint8Array(thisArg.response);
              if (bytes.byteLength > MAX_TEXT) return;
              const decoder = new TextDecoder();
              if (!kindOf(decoder.decode(bytes.subarray(0, 512)))) return;
              report(thisArg.responseURL, decoder.decode(bytes), true);
            }
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
