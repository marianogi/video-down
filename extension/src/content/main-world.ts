/**
 * Runs in the page's MAIN world at document_start (declared in manifest.json).
 *
 * Purpose: notice when a <video> uses Encrypted Media Extensions (Widevine,
 * PlayReady, FairPlay, ClearKey) so the overlay can warn that the video is
 * DRM-protected. It never touches keys, licences or media data.
 *
 * It marks the element with `data-video-down-drm="<key system>"` and dispatches
 * a `video-down:drm` event on it. The isolated content script reads either.
 *
 * Wrappers are Proxies so `Function.prototype.toString` still reports native
 * code and pages that inspect these APIs keep working.
 */

(() => {
  const FLAG = "__videoDownEmeProbe";
  const w = window as unknown as Record<string, unknown>;
  if (w[FLAG]) return;
  w[FLAG] = true;

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
})();
