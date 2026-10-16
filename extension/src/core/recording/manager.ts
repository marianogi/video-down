/**
 * Recordings in progress, owned by the service worker (its timers keep running in the
 * background, unlike a hidden tab's). The recorder page is only a viewer and remote control:
 * closing it does not stop a recording, and the toolbar popup lists them to reopen it.
 */

import { isSafeHttpUrl } from "@host/protocol";
import { MessageType } from "../../shared/messages";
import { logger } from "../utils/logger";
import { CaptureReceiver } from "./capture-receiver";
import { HlsCopyRecorder, type CopyTrack } from "./hls-copy";
import type { TrackKind } from "./local-playlist";
import { hlsCodecs, profileById } from "./profiles";
import { deleteRecording, getRecording, listRecordings, putRecording, type RecordingInfo, type StoredPart } from "./store";

export interface StartRecordingPayload {
  mode: "copy" | "capture";
  title: string;
  label: string;
  /** Address of the frame that plays the video (copy: its Origin/Referer are sent to the CDN) */
  pageUrl: string;
  /** copy: the media playlist(s) to follow */
  tracks?: Array<{ track: TrackKind; playlistUrl: string }>;
  /** capture: profile id (see profiles.ts) */
  profile?: string;
}

export interface RecordingProgress extends RecordingInfo {
  /** Segments of a live playlist that could not be fetched in time */
  lost: number;
}

interface Origin {
  tabId: number;
  frameId: number;
  index: number;
  /** The tab's title: for a player embedded in an iframe it names the event, the frame's does not */
  tabTitle?: string;
}

interface Active {
  info: RecordingInfo;
  origin: Origin;
  lost: number;
  copy?: HlsCopyRecorder;
  receiver?: CaptureReceiver;
  port?: chrome.runtime.Port;
}

const active = new Map<string, Active>();
let onActivity: () => void = () => undefined;

export function setActivityListener(fn: () => void): void {
  onActivity = fn;
}

export function activeRecordingCount(): number {
  return active.size;
}

function newId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

function validate(p: StartRecordingPayload): string | null {
  if (p?.mode !== "copy" && p?.mode !== "capture") return "invalid mode";
  if (typeof p.title !== "string" || p.title.length > 500) return "invalid title";
  if (typeof p.label !== "string" || p.label.length > 80) return "invalid label";
  if (p.pageUrl && !isSafeHttpUrl(p.pageUrl)) return "invalid page";
  if (p.mode === "copy") {
    const tracks = p.tracks;
    if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 2) return "invalid tracks";
    for (const t of tracks) {
      if (!["main", "video", "audio"].includes(t?.track) || !isSafeHttpUrl(t.playlistUrl)) return "invalid track";
    }
  } else if (!profileById(String(p.profile))) {
    return "invalid profile";
  }
  return null;
}

async function notify(rec: Active): Promise<void> {
  const payload: RecordingProgress = { ...rec.info, lost: rec.lost };
  const message = { type: MessageType.RECORDING_PROGRESS, payload };
  chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  chrome.tabs.sendMessage(rec.origin.tabId, message, { frameId: rec.origin.frameId }, () => void chrome.runtime.lastError);
}

async function save(rec: Active): Promise<void> {
  rec.info.updatedAt = Date.now();
  await putRecording(rec.info).catch((err) => logger.error("recording state", err));
  void notify(rec);
}

function onPart(rec: Active, part: StoredPart): void {
  if (rec.info.bytes === 0 && rec.info.mode === "copy") rec.info.container = part.initId !== undefined ? "mp4" : "ts";
  rec.info.bytes += part.size;
  if (part.track !== "audio") rec.info.duration += part.duration;
  void save(rec);
}

async function finish(id: string, state: RecordingInfo["state"], error?: string): Promise<void> {
  const rec = active.get(id);
  if (!rec) return;
  active.delete(id);
  rec.info.state = state;
  if (error) rec.info.error = error;
  await save(rec);
  onActivity();
}

export async function startRecording(
  payload: StartRecordingPayload,
  origin: Origin,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const invalid = validate(payload);
  if (invalid) return { success: false, error: invalid };
  const id = newId();
  const now = Date.now();
  const tracks: TrackKind[] = payload.mode === "copy" ? payload.tracks!.map((t) => t.track) : ["main"];
  const info: RecordingInfo = {
    id,
    mode: payload.mode,
    title: (origin.frameId !== 0 && origin.tabTitle?.trim().slice(0, 500)) || payload.title || "video",
    label: payload.label,
    container: payload.mode === "capture" ? "mp4" : "ts",
    tracks,
    pageUrl: payload.pageUrl,
    createdAt: now,
    updatedAt: now,
    state: "recording",
    bytes: 0,
    duration: 0,
  };
  await putRecording(info);
  const rec: Active = { info, origin, lost: 0 };
  active.set(id, rec);
  onActivity();

  if (payload.mode === "copy") {
    const copyTracks: CopyTrack[] = payload.tracks!.map((t) => ({ track: t.track, playlistUrl: t.playlistUrl }));
    rec.copy = new HlsCopyRecorder(id, copyTracks, payload.pageUrl, {
      onPart: (part) => onPart(rec, part),
      onLost: (_track, count) => {
        rec.lost += count;
        void notify(rec);
      },
      onEnded: () => void finish(id, "ended"),
      onError: (message) => void finish(id, "error", message),
    });
    void rec.copy.start().then(() => finish(id, "stopped"));
  } else {
    rec.receiver = new CaptureReceiver(id, (part) => onPart(rec, part));
  }

  // Copy: the user came to watch it in time-shift. Capture: the page must stay in front so the
  // player keeps drawing frames; the recorder tab opens behind it.
  await chrome.tabs
    .create({
      url: chrome.runtime.getURL(`recorder/recorder.html?id=${id}`),
      index: origin.index + 1,
      openerTabId: origin.tabId,
      active: payload.mode === "copy",
    })
    .catch((err) => logger.warn("could not open the recorder page", err));
  return { success: true, id };
}

/** The page's capture port (see content/capture.ts). Returns false if it is not one. */
export function onCapturePort(port: chrome.runtime.Port): boolean {
  const m = port.name.match(/^vd-capture:([a-z0-9]{1,40})$/);
  if (!m) return false;
  const rec = active.get(m[1]!);
  // Only the frame that started this capture may feed it.
  if (!rec?.receiver || rec.port || port.sender?.tab?.id !== rec.origin.tabId || port.sender?.frameId !== rec.origin.frameId) {
    port.disconnect();
    return true;
  }
  rec.port = port;
  let ending = false;
  const end = (reason: string) => {
    if (ending) return;
    ending = true;
    void rec.receiver!.finish().then(() => finish(rec.info.id, reason === "source-ended" ? "ended" : "stopped"));
  };
  port.onMessage.addListener((msg: { type?: string; data?: string; reason?: string; mimeType?: string; audio?: boolean }) => {
    if (msg?.type === "info" && typeof msg.mimeType === "string") {
      const codecs = hlsCodecs(msg.mimeType);
      if (codecs) rec.info.codecs = codecs;
      if (msg.audio === false) rec.info.noAudio = true;
      void save(rec);
    } else if (msg?.type === "restart") {
      void rec.receiver!.reset();
    } else if (msg?.type === "chunk" && typeof msg.data === "string") {
      rec.receiver!.push(msg.data).catch((err) => {
        logger.error("capture data", err);
        port.disconnect();
        void finish(rec.info.id, "error", "invalid data from the page");
      });
    } else if (msg?.type === "end") {
      end(String(msg.reason ?? "stopped"));
    }
  });
  port.onDisconnect.addListener(() => end("stopped"));
  return true;
}

export async function stopRecording(id: string): Promise<void> {
  const rec = active.get(id);
  if (!rec) return;
  if (rec.copy) rec.copy.stop();
  else if (rec.port) rec.port.postMessage({ type: "stop" });
  else await finish(id, "stopped");
}

export async function discardRecording(id: string): Promise<void> {
  await stopRecording(id);
  active.delete(id);
  onActivity();
  await deleteRecording(id);
  chrome.runtime.sendMessage({ type: MessageType.RECORDING_PROGRESS, payload: { id, deleted: true } }, () => void chrome.runtime.lastError);
}

export async function recordingProgress(id: string): Promise<RecordingProgress | null> {
  const rec = active.get(id);
  if (rec) return { ...rec.info, lost: rec.lost };
  const info = await getRecording(id);
  return info ? { ...info, lost: 0 } : null;
}

/** A worker restart killed whatever was recording: those recordings are stopped, not lost. */
export async function markInterruptedRecordings(): Promise<void> {
  for (const info of await listRecordings().catch(() => [])) {
    if (info.state === "recording" && !active.has(info.id)) {
      await putRecording({ ...info, state: "stopped", error: "interrupted" }).catch(() => undefined);
    }
  }
}
