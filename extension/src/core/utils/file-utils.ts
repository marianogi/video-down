/**
 * File utility functions
 */

/**
 * Sanitize filename by removing what Chrome or the system refuse in a download's name.
 * Chrome also rejects "~", format characters (zero-width joiners, bidi marks…), half an emoji and a
 * name that starts or ends in a dot or a space; video-down then lost the name and the chosen folder.
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/\p{Cc}/gu, " ") // A line break separates words
    .replace(/[<>:"/\\|?*~]/g, "") // Windows: < > : " / \ | ? *  Unix/Mac: /
    .replace(/[\p{Cf}\p{Cs}﷐-﷯￾￿]/gu, "")
    .replace(/\s+/g, " ") // Normalize whitespace
    .replace(/^[\s.]+|[\s.]+$/g, "");
}

const MAX_CHANNEL_LENGTH = 40;
const MAX_WORDS_LENGTH = 80;

/** Titles that say nothing about the video: Instagram's is always "Video by <account>". */
const GENERIC_TITLE = /^(?:(?:video|reel|post|photo|image|story)\s+(?:by|from|de)\s+.*|instagram|tiktok|facebook|twitter|x)$/i;

/** Cut at a word when possible. Half an emoji left by the cut is removed by sanitizeFilename. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const space = text.slice(0, max + 1).lastIndexOf(" ");
  return text.slice(0, space > max / 2 ? space : max);
}

const bareHost = (text: string) => text.trim().replace(/^www\./i, "").toLowerCase();

/** The first line of a text, without links, hashtags and mentions. */
function wordsOf(text: string | undefined): string {
  const line = text?.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const clean = line.replace(/https?:\/\/\S+/g, " ").replace(/(^|\s)[#@][\p{L}\p{N}_.]+/gu, " ");
  return sanitizeFilename(clean);
}

export interface MediaNameParts {
  /** Channel or account that published it */
  channel?: string | undefined;
  title?: string | undefined;
  /** The post's text, used when the title says nothing */
  description?: string | undefined;
  /** Label of the chosen quality */
  quality?: string | undefined;
}

/** A video's file name, without extension: "<channel> - <some words of the title> <quality>". */
export function mediaFileBase({ channel, title, description, quality }: MediaNameParts): string {
  const owner = shorten(sanitizeFilename(channel ?? ""), MAX_CHANNEL_LENGTH).replace(/^[-\s.]+/, "");
  // X's title is "<account> - <text>": the account is already in the name.
  let heading = title?.trim() ?? "";
  if (owner && heading.toLowerCase().startsWith(owner.toLowerCase())) {
    heading = heading.slice(owner.length).replace(/^\s*[-–—:|]\s*/, "");
  }
  const generic = GENERIC_TITLE.test(heading) || bareHost(heading) === bareHost(channel ?? "");
  const words = (!generic && wordsOf(heading)) || wordsOf(description) || (owner ? "" : wordsOf(title));
  const name = [owner, shorten(words, MAX_WORDS_LENGTH)].filter(Boolean).join(" - ");
  return sanitizeFilename(`${name} ${sanitizeFilename(quality ?? "")}`).replace(/^[-\s.]+/, "") || "video";
}

/** A short lowercase extension, or MP4. */
export function mediaExtension(extension: string | undefined): string {
  return extension && /^[a-z0-9]{2,5}$/i.test(extension) ? extension.toLowerCase() : "mp4";
}

/** The same file name with the extension the file really has. */
export function replaceExtension(filename: string, extension: string): string {
  return `${filename.replace(/\.[A-Za-z0-9]{1,5}$/, "")}.${extension}`;
}
