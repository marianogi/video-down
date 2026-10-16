/**
 * Recorder page: remote control of one recording, and its player.
 *
 * The recording itself runs in the service worker (see core/recording/manager.ts). This page shows
 * its progress and, by state:
 *  - recording: Stop and Discard (stop and delete). The live keeps playing in its own tab, so no
 *    player here unless asked for: «Watch time-shifted» plays what has been recorded so far with
 *    hls.js (pause, rewind, «Go to live») while the recording goes on;
 *  - stopped: the file name, Save as… and Discard;
 *  - saved: where it was saved, «Show in folder», and the player to watch it here.
 * Closing the page does not stop the recording.
 */

import Hls from "hls.js";
import { localize, sendMessage } from "../ui/dom";
import { formatBytes, t } from "../shared/i18n";
import { MessageType } from "../shared/messages";
import { playlistUrl } from "../core/recording/local-playlist";
import type { RecordingProgress } from "../core/recording/manager";
import { makeLocalLoader } from "./local-loader";
import { defaultName, saveRecording } from "./save";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("player");
const id = new URLSearchParams(location.search).get("id") ?? "";

let info: RecordingProgress | null = null;
let hls: Hls | null = null;
let saving = false;
let gone = false;
/** The person asked to watch it while it records */
let timeshift = false;
let noPlayer = false;

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

function show(elementId: string, visible: boolean): void {
  $(elementId).hidden = !visible;
}

function render(): void {
  if (gone) return;
  if (!info) {
    $("title").textContent = t("recUnknown");
    for (const b of ["stop", "save", "discard", "show", "timeshift", "name-field", "player-actions"]) show(b, false);
    return;
  }
  const recording = info.state === "recording";
  const saved = !!info.savedPath;
  const hasData = info.bytes > 0;
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

  // Buttons: recording → Stop, Discard. Stopped → Save as…, Discard. Saved → also Show in folder.
  show("stop", recording);
  show("save", !recording && hasData);
  $<HTMLButtonElement>("save").disabled = saving;
  show("discard", true);
  show("show", saved && !saving);
  show("name-field", !recording && hasData);
  proposeName();

  // The box: the player once saved (or when asked for while recording), a note otherwise.
  const playerWanted = hasData && !noPlayer && (saved || timeshift);
  show("player", playerWanted);
  show("placeholder", !playerWanted);
  $("placeholder-text").textContent = noPlayer
    ? t("recNoPlayer")
    : recording
      ? t(hasData ? "recRecordingHere" : "recWaiting")
      : t(hasData ? "recStoppedHere" : "recNothing");
  show("timeshift", recording && hasData && !timeshift && !noPlayer);
  show("player-actions", recording && timeshift && !noPlayer);
  if (playerWanted && !hls) startPlayer();

  const status = $("save-status");
  if (saved && !saving && !status.textContent) {
    status.textContent = t("recSaved", info.savedPath!);
    status.className = "ok";
  }
  $("hint").textContent = t(recording ? (info.mode === "copy" ? "recHintCopy" : "recHintCapture") : saved ? "recHintSaved" : "recHintStopped");
}

function startPlayer(): void {
  if (!info) return;
  if (!Hls.isSupported()) {
    noPlayer = true;
    render();
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
    $<HTMLButtonElement>("live").disabled = false;
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    console.warn("[video-down] recording player:", data.type, data.details, data.fatal ? "(fatal)" : "", data.error?.message ?? "");
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
    show("player", false);
    show("placeholder", true);
    $("placeholder-text").textContent = t("recDiscarded");
    $("notice").hidden = true;
    for (const b of ["stop", "save", "discard", "show", "timeshift", "name-field", "player-actions"]) show(b, false);
    return false;
  }
  info = message.payload as RecordingProgress;
  render();
  return false;
});

$("timeshift").addEventListener("click", () => {
  timeshift = true;
  render();
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

// The file name: proposed from the title, quality and start time, until the person types another.
const nameInput = $<HTMLInputElement>("name");
let nameEdited = false;
nameInput.addEventListener("input", () => (nameEdited = true));
function proposeName(): void {
  if (info && !nameEdited && !nameInput.value) nameInput.value = defaultName(info);
}

$("show").addEventListener("click", () => {
  if (info?.savedDownloadId !== undefined) chrome.downloads.show(info.savedDownloadId);
});

$("save").addEventListener("click", async () => {
  if (!info || saving) return;
  saving = true;
  const status = $("save-status");
  status.className = "muted";
  render();
  const stages = { building: t("recBuilding"), converting: t("recConverting"), saving: t("recSavingFile") };
  try {
    const files = await saveRecording(info, (stage) => (status.textContent = stages[stage]), nameInput.value);
    const first = files[0];
    status.textContent = t("recSaved", files.map((f) => f.path).join(" · "));
    status.className = "ok";
    // Remembered with the recording: the page shows it again if reopened, and its player.
    if (first) await sendMessage(MessageType.MARK_RECORDING_SAVED, { id, path: first.path, downloadId: first.id }).catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = /USER_CANCELED/i.test(message);
    status.textContent = cancelled ? t("recSaveCancelled") : t("recSaveFailed", message);
    status.className = cancelled ? "muted" : "error";
  } finally {
    saving = false;
    render();
  }
});

$("discard").addEventListener("click", async () => {
  if (!info) return;
  const question = info.state === "recording" ? "recDiscardRecording" : info.savedPath ? "recDiscardSaved" : "recDiscardConfirm";
  if (!confirm(t(question))) return;
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
