/**
 * Read what the router needs from a live <video> element.
 */

import type { DirectSource, VideoFacts } from "../core/router";

export const DRM_ATTR = "data-video-down-drm";

const LABEL_ATTRS = ["label", "size", "res", "data-res", "data-quality", "title"];

function isHttp(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function heightFrom(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d{3,4})\s*p?\b/i);
  const h = m ? Number(m[1]) : NaN;
  return h >= 144 && h <= 4320 ? h : undefined;
}

export function readSources(video: HTMLVideoElement): DirectSource[] {
  const out: DirectSource[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(video.querySelectorAll("source"))) {
    const url = (el as HTMLSourceElement).src;
    if (!url || !isHttp(url) || seen.has(url)) continue;
    seen.add(url);
    let label: string | undefined;
    for (const attr of LABEL_ATTRS) {
      const v = el.getAttribute(attr)?.trim();
      if (v) {
        label = v.slice(0, 40);
        break;
      }
    }
    const source: DirectSource = { url };
    const height = heightFrom(label) ?? heightFrom(url.split("/").pop());
    if (label) source.label = label;
    if (height) source.height = height;
    const type = el.getAttribute("type");
    if (type) source.type = type;
    out.push(source);
  }
  return out;
}

export function readFacts(video: HTMLVideoElement, loadStartedAt: number, firstSeenAt: number): VideoFacts {
  const facts: VideoFacts = {
    src: video.currentSrc || video.src || "",
    sources: readSources(video),
    drm: video.getAttribute(DRM_ATTR),
    loadingForMs: Date.now() - (loadStartedAt || firstSeenAt),
  };
  if (Number.isFinite(video.duration) && video.duration > 0) facts.duration = video.duration;
  return facts;
}

/** A readable title for the file name: og:title, then document title. */
export function pageTitle(): string {
  const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  return (og || document.title || location.hostname).slice(0, 150);
}
