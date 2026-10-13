/**
 * The user's session on a site, lent to yt-dlp only when it asks for it.
 *
 * Many sites (Instagram, Facebook, private Vimeo, Patreon, course platforms…) only show a video
 * to a logged-in user. yt-dlp can use the browser's cookies, but it cannot read Chrome's own
 * store on Windows since Chrome 127 (app-bound encryption). So the extension hands them over:
 *  - only after an anonymous attempt failed for a reason that a session can fix;
 *  - only the cookies Chrome itself would send to that URL (chrome.cookies.getAll({ url }));
 *  - the native host checks again that each one belongs to that site, keeps them in a temporary
 *    file for that single yt-dlp run and deletes it afterwards.
 * Generic: no site names, except YouTube, which has its own setting (see README).
 */

import { cookieMatchesUrl, MAX_COOKIE_CHARS, MAX_COOKIES, type SessionCookie } from "@host/protocol";

/**
 * yt-dlp errors that mean "log in first": cookies asked for explicitly, login or sign-in
 * walls, 401/403, private or members-only content, age checks and YouTube's bot check.
 */
const SESSION_NEEDED_RE =
  /cookies|log(?:ged)?[ -]?in\b|sign[ -]?in\b|authenticat|HTTP Error 40[13]\b|\bprivate\b|members?[ -]only|age[ -]restrict|confirm your age|not a bot|empty media response/i;

export function needsSession(message: string): boolean {
  return SESSION_NEEDED_RE.test(message);
}

/** The fields of chrome.cookies.Cookie this module uses (kept minimal for the unit tests). */
export interface BrowserCookie {
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  name: string;
  value: string;
  session: boolean;
  expirationDate?: number;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Browser cookie → protocol cookie; null for anything the host would refuse anyway. */
export function toSessionCookie(c: BrowserCookie): SessionCookie | null {
  if (!c.name || /[\s;=,]/.test(c.name) || CONTROL_RE.test(c.name) || CONTROL_RE.test(c.value)) return null;
  if (c.value.length > MAX_COOKIE_CHARS || !c.path.startsWith("/")) return null;
  const cookie: SessionCookie = {
    domain: c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    name: c.name,
    value: c.value,
  };
  if (!c.session && typeof c.expirationDate === "number" && Number.isFinite(c.expirationDate)) {
    cookie.expires = Math.floor(c.expirationDate);
  }
  return cookie;
}

/** The cookies Chrome would send to `url`, ready for the native host. */
export async function sessionCookiesFor(url: string): Promise<SessionCookie[]> {
  const all = (await chrome.cookies.getAll({ url })) as BrowserCookie[];
  const out: SessionCookie[] = [];
  for (const c of all) {
    const cookie = toSessionCookie(c);
    if (cookie && cookieMatchesUrl(cookie, url)) out.push(cookie);
    if (out.length >= MAX_COOKIES) break;
  }
  return out;
}
