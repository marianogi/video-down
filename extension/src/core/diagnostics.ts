/**
 * Diagnostic report: what the extension saw in one tab and what it did with it.
 *
 * Shown on the options page (and copied by the user) when a video is not offered as expected,
 * so the cause can be found without DevTools. Addresses keep host and path only: query strings
 * and fragments, where tokens and signatures travel, are never included. Pure: unit-tested.
 */

export type DiagSource = "network" | "worker" | "page" | "frame";

export interface DiagEntry {
  at: number;
  /** Frame that saw it; null for requests made by a service worker */
  frameId: number | null;
  source: DiagSource;
  event: string;
  /** Already reduced with diagUrl() */
  url?: string;
  detail?: string;
}

export interface DiagInput {
  generatedAt: number;
  version: string;
  platform: string;
  browser: string;
  native: string;
  tabUrl?: string;
  frames: Array<{ frameId: number; url: string }>;
  entries: DiagEntry[];
}

/** host + full path, no query or fragment; "?…" marks that the address had a query. */
export function diagUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol}…`;
    const path = u.pathname.length > 240 ? `${u.pathname.slice(0, 120)}…${u.pathname.slice(-110)}` : u.pathname;
    return `${u.host}${path}${u.search ? "?…" : ""}`;
  } catch {
    return url.split(/[?#]/)[0]!.slice(0, 120);
  }
}

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function where(e: DiagEntry): string {
  if (e.source === "worker") return "SW";
  return e.frameId === null ? "?" : `#${e.frameId}`;
}

export function formatDiagnostics(d: DiagInput): string {
  const lines: string[] = [];
  lines.push(`video-down ${d.version} · ${d.platform} · ${d.browser}`);
  lines.push(`native component: ${d.native}`);
  lines.push(`generated: ${new Date(d.generatedAt).toISOString()}`);
  if (d.tabUrl) lines.push(`tab: ${diagUrl(d.tabUrl)}`);
  lines.push("");
  lines.push("frames:");
  if (d.frames.length === 0) lines.push("  (none reported)");
  for (const f of [...d.frames].sort((a, b) => a.frameId - b.frameId)) lines.push(`  #${f.frameId} ${f.url}`);
  lines.push("");
  lines.push("events (network = requests seen by the extension; frame = what the frame concluded):");
  const entries = [...d.entries].sort((a, b) => a.at - b.at);
  if (entries.length === 0) lines.push("  (none: no HLS/DASH playlist has been seen in this tab)");
  for (const e of entries) {
    const parts = [clock(e.at), where(e).padEnd(5), e.source.padEnd(7), e.event];
    if (e.url) parts.push(e.url);
    if (e.detail) parts.push(`(${e.detail})`);
    lines.push(`  ${parts.join(" ")}`);
  }
  return lines.join("\n");
}
