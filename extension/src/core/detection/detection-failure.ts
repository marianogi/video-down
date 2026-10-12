/**
 * Why a manifest seen on the network could not be read. Shown in the overlay so
 * the user (and whoever debugs it) knows what happened instead of a silent
 * fallback. Generic: nothing here is specific to a site.
 */

import type { VideoFormat } from "../types";

export type FailureReason = "http" | "not-playlist" | "network";
export type BodyKind = "html" | "json" | "xml" | "binary" | "text" | "empty";

export interface DetectionFailure {
  /** Full URL (kept only in memory, never logged with its query string) */
  url: string;
  format: VideoFormat;
  reason: FailureReason;
  status?: number;
  body?: BodyKind;
  at: number;
}

export function statusFromError(err: unknown): number | undefined {
  const m = (err instanceof Error ? err.message : String(err)).match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : undefined;
}

/** Rough classification of a body that should have been a playlist. */
export function describeBody(text: string): BodyKind {
  const head = text.slice(0, 2048);
  const trimmed = head.trimStart();
  if (trimmed.length === 0) return "empty";
  if (/^<!doctype html|^<html/i.test(trimmed)) return "html";
  if (/^</.test(trimmed)) return "xml";
  if (/^[[{]/.test(trimmed)) return "json";
  let controls = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) controls++;
  }
  return controls > head.length * 0.1 ? "binary" : "text";
}

/** host + path, without the query string (which often carries tokens). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 60 ? `${u.pathname.slice(0, 28)}…${u.pathname.slice(-28)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 80);
  }
}
