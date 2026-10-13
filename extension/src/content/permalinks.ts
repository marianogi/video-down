/**
 * The video's own page, for pages that only list videos (feeds, timelines, grids).
 *
 * yt-dlp needs the address of a post, not of the feed that shows it. Feeds link each post to its
 * own page with two widespread conventions, used here instead of any list of sites:
 *  - a link around the post's date, `<a href="…"><time …></time></a>` (Instagram, X, Mastodon,
 *    Reddit, Tumblr, blogs…);
 *  - `rel="bookmark"`, the HTML permalink convention.
 * The search goes outwards from the video and stops at the first container that has such links.
 * If that container holds several different ones, it already spans several posts: nothing is
 * returned rather than guessing another post's link.
 */

const MAX_DEPTH = 15;

function withoutHash(url: string): string {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

function isPermalink(a: HTMLAnchorElement): boolean {
  return !!a.querySelector("time") || /(^|\s)bookmark(\s|$)/i.test(a.rel);
}

export function permalinkNear(video: Element, pageUrl: string): string | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  const page = withoutHash(pageUrl);
  let node: Element | null = video.parentElement;
  for (let depth = 0; node && depth < MAX_DEPTH; depth++, node = node.parentElement) {
    const found = new Set<string>();
    let pointsHere = false;
    for (const a of node.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (!isPermalink(a)) continue;
      let url: URL;
      try {
        url = new URL(a.href);
      } catch {
        continue;
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname !== host) continue;
      const href = withoutHash(url.href);
      if (href === page) pointsHere = true;
      else found.add(href);
    }
    if (found.size === 1 && !pointsHere) return [...found][0]!;
    // Several links: already spanning several posts. Or the post's link is this very page.
    if (found.size > 0 || pointsHere) return null;
  }
  return null;
}
