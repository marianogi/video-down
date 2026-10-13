/**
 * Find the master playlist of a variant playlist that was requested on its own.
 *
 * Sometimes a page only lets the extension see one variant playlist: the master was read in a
 * way the extension could not observe, or the player was handed a single quality. The master
 * then usually sits next to it, named after the conventions of widespread HLS packagers. This
 * module only builds candidate URLs; the caller accepts one ONLY if it is a real master that
 * lists the playlist being played. Generic: packager conventions, never site names.
 */

const MAX_CANDIDATES = 4;

/** Folder names that hold one rendition (…/720p/index.m3u8, …/v1/prog.m3u8, …/hd/…). */
const RENDITION_FOLDER = /^(?:\d{3,4}p?|\d{2,5}k|v\d{1,2}|stream_?\d{1,2}|low|mid|medium|high|sd|hd|fhd|uhd)$/i;

/** Rendition suffix in a file name: name_720p.m3u8, name-1280x720.m3u8, name_720p_3000k.m3u8. */
const RENDITION_SUFFIX = /^(.+?)[_-](?:\d{3,4}p|\d{3,4}x\d{3,4}|\d{2,5}k)(?:[_-](?:\d{2,5}k|\d{2,3}fps))*\.m3u8$/i;

export function masterCandidates(mediaUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(mediaUrl);
  } catch {
    return [];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  const slash = u.pathname.lastIndexOf("/");
  const dir = u.pathname.slice(0, slash + 1);
  const file = u.pathname.slice(slash + 1);
  if (!/\.m3u8$/i.test(file)) return [];

  const paths: string[] = [];
  // Unified Streaming Origin: <presentation>-audio_eng=128000-video_eng=2000000.m3u8 → <presentation>.m3u8
  const unified = file.match(/^(.+?)-(?:audio|video|textstream)(?:_[a-z0-9-]+)?=\d+.*\.m3u8$/i);
  if (unified) paths.push(`${dir}${unified[1]}.m3u8`);
  // Wowza Streaming Engine: chunklist_w123_b800000.m3u8 → playlist.m3u8
  if (/^chunklist(?:_[^/]*)?\.m3u8$/i.test(file)) paths.push(`${dir}playlist.m3u8`);
  // nginx-vod-module (and Kaltura): index-v1-a1.m3u8 → master.m3u8
  if (/^index-[^/]+\.m3u8$/i.test(file)) paths.push(`${dir}master.m3u8`);
  // Encoders that name each rendition after the master: name_720p.m3u8 → name.m3u8
  const suffix = file.match(RENDITION_SUFFIX);
  if (suffix) paths.push(`${dir}${suffix[1]}.m3u8`);
  // One folder per rendition: the master usually sits one level up.
  const parentSlash = dir.slice(0, -1).lastIndexOf("/");
  const folder = dir.slice(parentSlash + 1, -1);
  if (parentSlash >= 0 && RENDITION_FOLDER.test(folder)) {
    const parent = dir.slice(0, parentSlash + 1);
    paths.push(`${parent}master.m3u8`, `${parent}playlist.m3u8`, `${parent}index.m3u8`);
  }
  // Last resort: the most common master name, in the same folder.
  paths.push(`${dir}master.m3u8`);

  const out: string[] = [];
  for (const path of paths) {
    if (path.toLowerCase() === u.pathname.toLowerCase()) continue;
    const candidate = new URL(u.href);
    candidate.pathname = path;
    candidate.hash = "";
    if (!out.includes(candidate.href)) out.push(candidate.href);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * A master found this way was requested with the query string of the playlist really played
 * (CDN tokens usually travel there). Give the same query to the URIs it lists that have none,
 * so the qualities it offers can be fetched with the same authorisation the player had.
 */
export function withInheritedQuery(masterText: string, fromUrl: string): string {
  let query: string;
  try {
    query = new URL(fromUrl).search;
  } catch {
    return masterText;
  }
  if (!query) return masterText;
  const add = (uri: string): string =>
    uri.includes("?") || /^(?:data|blob):/i.test(uri) ? uri : `${uri}${query}`;
  return masterText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith("#")) return add(trimmed);
      return line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${add(uri)}"`);
    })
    .join("\n");
}
