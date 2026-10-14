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

function withoutHash(url: string): string {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

function linkToOtherPage(href: string | undefined): string | undefined {
  if (!href || !isHttp(href)) return undefined;
  return withoutHash(href) === withoutHash(location.href) ? undefined : href;
}

/** Share of `inner` (the video's box) covered by `outer`. */
function overlap(outer: DOMRect, inner: DOMRect): number {
  const w = Math.min(outer.right, inner.right) - Math.max(outer.left, inner.left);
  const h = Math.min(outer.bottom, inner.bottom) - Math.max(outer.top, inner.top);
  return w > 0 && h > 0 ? (w * h) / (inner.width * inner.height) : 0;
}

function sameScreen(root: Document | ShadowRoot, x: number, y: number, skip?: Element): Element[] {
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return [];
  return root.elementsFromPoint(x, y).filter((el) => !skip || (el !== skip && !skip.contains(el)));
}

/**
 * The page a video previews. Thumbnails that play on hover (YouTube, Vimeo, Twitch, news sites…)
 * are teasers of another page: clicking them opens the full video. Then what the user wants is that
 * page's video, never the teaser. Generic, two ways of telling:
 *  - the video is inside a link to another http(s) page;
 *  - a link to another page covers most of the video's box, over it or under it (a preview player
 *    laid over the thumbnail it previews, as YouTube does on some pages).
 * `skip` is the extension's own overlay, ignored when looking at what is on screen.
 */
export function previewTarget(video: HTMLVideoElement, skip?: Element): string | undefined {
  const around = linkToOtherPage((video.closest("a[href]") as HTMLAnchorElement | null)?.href);
  if (around) return around;
  const r = video.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return undefined;
  const root = video.getRootNode() as Document | ShadowRoot;
  for (const el of sameScreen(root, r.left + r.width / 2, r.top + r.height / 2, skip)) {
    const link = el.closest("a[href]") as HTMLAnchorElement | null;
    const href = linkToOtherPage(link?.href);
    if (!link || !href) continue;
    if (Math.max(overlap(link.getBoundingClientRect(), r), overlap(el.getBoundingClientRect(), r)) >= 0.5) return href;
  }
  return undefined;
}

/** Levels above the video where a player keeps its controls and click layers. */
const PLAYER_DEPTH = 8;

/** Whether `el`, on top at some point of the video, is part of the same player. */
function partOfPlayer(el: Element, video: HTMLVideoElement): boolean {
  if (el === video || video.contains(el) || el.contains(video)) return true;
  let box: Element | null = video.parentElement;
  for (let i = 0; box && i < PLAYER_DEPTH; i++, box = box.parentElement) {
    if (box === document.body || box === document.documentElement) return false;
    if (box.contains(el)) return true;
  }
  return false;
}

/**
 * Whether the video is out of sight although laid out: covered by something else of the page, or
 * transparent. Single-page sites keep old players under the new page (YouTube leaves its preview
 * player under the video it opens): such a player must not get an icon.
 */
export function isOutOfSight(video: HTMLVideoElement, skip?: Element): boolean {
  let node: Element | null = video;
  for (let i = 0; node && i <= PLAYER_DEPTH; i++, node = node.parentElement) {
    if (Number(getComputedStyle(node).opacity) < 0.05) return true;
  }
  const r = video.getBoundingClientRect();
  const root = video.getRootNode() as Document | ShadowRoot;
  const points = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + 24, r.top + 24],
    [r.right - 24, r.bottom - 24],
  ];
  let looked = 0;
  for (const [x, y] of points) {
    const stack = sameScreen(root, x!, y!, skip);
    if (stack.length === 0) continue;
    looked++;
    if (partOfPlayer(stack[0]!, video)) return false;
  }
  return looked > 0;
}

/** A live broadcast: an unbounded timeline, as players give to live streams and to MediaStreams. */
export function isLiveElement(video: HTMLVideoElement): boolean {
  return video.duration === Infinity;
}

export function readFacts(video: HTMLVideoElement, loadStartedAt: number, firstSeenAt: number): VideoFacts {
  const facts: VideoFacts = {
    src: video.currentSrc || video.src || "",
    sources: readSources(video),
    drm: video.getAttribute(DRM_ATTR),
    loadingForMs: Date.now() - (loadStartedAt || firstSeenAt),
  };
  if (Number.isFinite(video.duration) && video.duration > 0) facts.duration = video.duration;
  const preview = previewTarget(video, document.querySelector("video-down-overlay") ?? undefined);
  if (preview) facts.previewOf = preview;
  return facts;
}

/** A readable title for the file name: og:title, then document title. */
export function pageTitle(): string {
  const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  return (og || document.title || location.hostname).slice(0, 150);
}
