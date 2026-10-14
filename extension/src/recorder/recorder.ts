/**
 * Recorder page: time-shift viewer and remote control of one recording.
 *
 * The recording itself runs in the service worker (see core/recording/manager.ts); this page
 * plays what has been stored so far with hls.js (pause, rewind, back to the newest moment),
 * shows its progress, and stops, saves or discards it. Closing the page does not stop it.
 */

import Hls from "hls.js";
import { localize, sendMessage } from "../ui/dom";
import { formatBytes, t } from "../shared/i18n";
import { MessageType } from "../shared/messages";
import { playlistUrl } from "../core/recording/local-playlist";
import type { RecordingProgress } from "../core/recording/manager";
import { makeLocalLoader } from "./local-loader";
import { saveRecording } from "./save";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("player");
const id = new URLSearchParams(location.search).get("id") ?? "";

let info: RecordingProgress | null = null;
let hls: Hls | null = null;
let saving = false;
let gone = false;

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function errorText(error: string | undefined): string {
  if (!error) return "";
  if (error === "drm") return t("recDrm");
  if (error === "interrupted") return t("recInterrupted");
  return `${t("recErrorTitle")}: ${error.replace(/https?:\/\/\S+/g, "").slice(0, 200)}`;
}

function render(): void {
  if (gone) return;
  if (!info) {
    $("title").textContent = t("recUnknown");
    for (const b of ["stop", "save", "discard", "live"]) $<HTMLButtonElement>(b).disabled = true;
    return;
  }
  const recording = info.state === "recording";
  $("title").textContent = info.title;
  document.title = `${recording ? "● " : ""}${info.title} · video-down`;
  $("meta").textContent = t(info.mode === "copy" ? "recModeCopy" : "recModeCapture", info.label);
  const chip = $("state");
  chip.className = `chip${recording ? " rec" : ""}`;
  chip.textContent = t(
    recording ? "recStateRecording" : info.state === "ended" ? "recStateEnded" : info.state === "error" ? "recStateError" : "recStateStopped",
  );
  $("duration").textContent = clock(info.duration);
  $("size").textContent = formatBytes(info.bytes) || "0 B";

  const notices = [
    errorText(info.error),
    info.lost > 0 ? t("recLost", String(info.lost)) : "",
    info.noAudio ? t("recNoAudio") : "",
  ].filter(Boolean);
  const notice = $("notice");
  notice.hidden = notices.length === 0;
  notice.textContent = notices.join(" ");

  $<HTMLButtonElement>("stop").disabled = !recording;
  $<HTMLButtonElement>("save").disabled = saving || info.bytes === 0;
  $("hint").textContent = t(info.mode === "copy" ? "recHintCopy" : "recHintCapture");
  if (info.bytes > 0 && !hls) startPlayer();
}

function startPlayer(): void {
  if (!info) return;
  if (!Hls.isSupported()) {
    $("waiting").textContent = t("recNoPlayer");
    return;
  }
  hls = new Hls({
    loader: makeLocalLoader({ info: () => info }),
    // Extension pages may not start workers from blob: URLs; the main thread is enough here.
    enableWorker: false,
    liveSyncDurationCount: 2,
    backBufferLength: 180,
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    $("waiting").hidden = true;
    $<HTMLButtonElement>("live").disabled = false;
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    console.warn("[video-down] time-shift player:", data.type, data.details, data.fatal ? "(fatal)" : "", data.error?.message ?? "");
    if (!data.fatal || !hls) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else hls.startLoad();
  });
  // The master playlist carries the tracks and the codecs; a single track without declared
  // codecs can be played from its own playlist.
  const viaMaster = info.tracks.includes("video") || !!info.codecs;
  hls.loadSource(playlistUrl(info.id, viaMaster ? "master" : "main"));
  hls.attachMedia(video);
}

/** How far behind the newest recorded moment the player is. */
function updateDelay(): void {
  const delay = $("delay");
  if (!hls || !info || video.readyState === 0) {
    delay.textContent = "";
    return;
  }
  const edge = hls.liveSyncPosition ?? video.duration;
  if (!Number.isFinite(edge)) return;
  const behind = edge - video.currentTime;
  delay.textContent = behind > 6 ? t("recBehind", clock(behind)) : t("recAtLive");
}

async function refresh(): Promise<void> {
  const reply = await sendMessage<{ success: boolean; recording: RecordingProgress | null }>(MessageType.GET_RECORDING, { id }).catch(
    () => null,
  );
  info = reply?.recording ?? null;
  render();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== MessageType.RECORDING_PROGRESS || message.payload?.id !== id) return false;
  if (message.payload.deleted) {
    gone = true;
    hls?.destroy();
    hls = null;
    $("notice").hidden = false;
    $("notice").textContent = t("recDiscarded");
    for (const b of ["stop", "save", "discard", "live"]) $<HTMLButtonElement>(b).disabled = true;
    return false;
  }
  info = message.payload as RecordingProgress;
  render();
  return false;
});

$("live").addEventListener("click", () => {
  if (!hls) return;
  const edge = hls.liveSyncPosition ?? video.duration;
  if (Number.isFinite(edge)) video.currentTime = edge;
  void video.play().catch(() => undefined);
});

$("stop").addEventListener("click", () => {
  $<HTMLButtonElement>("stop").disabled = true;
  void sendMessage(MessageType.STOP_RECORDING, { id });
});

$("save").addEventListener("click", async () => {
  if (!info || saving) return;
  saving = true;
  render();
  const status = $("save-status");
  const stages = { building: t("recBuilding"), converting: t("recConverting"), saving: t("recSavingFile") };
  try {
    const names = await saveRecording(info, (stage) => (status.textContent = stages[stage]));
    status.textContent = t("recSaved", names.join(" · "));
    status.className = "ok";
  } catch (err) {
    status.textContent = t("recSaveFailed", err instanceof Error ? err.message : String(err));
    status.className = "error";
  } finally {
    saving = false;
    render();
  }
});

$("discard").addEventListener("click", async () => {
  if (!confirm(t("recDiscardConfirm"))) return;
  await sendMessage(MessageType.DISCARD_RECORDING, { id }).catch(() => undefined);
});

localize();
if (/^[a-z0-9]{1,40}$/.test(id)) {
  void refresh();
  // Progress messages are the normal path; this only covers a restarted worker.
  setInterval(() => void (gone ? undefined : refresh()), 5000);
} else {
  render();
}
setInterval(updateDelay, 1000);
