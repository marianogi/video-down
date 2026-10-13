/**
 * Options page: settings, native component status/update and install steps.
 */

import { localize, sendMessage } from "../ui/dom";
import { t } from "../shared/i18n";
import { MessageType, type NativeStatusReply } from "../shared/messages";
import { resolveSettings } from "../core/storage/settings";
import type { StorageConfig } from "../core/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const extensionVersion = chrome.runtime.getManifest().version;
$("ext-version").textContent = chrome.runtime.getManifest().version_name ?? extensionVersion;

async function loadNative(force = false): Promise<void> {
  const chip = $<HTMLSpanElement>("native-chip");
  chip.className = "chip";
  chip.textContent = t("nativeChecking");
  const status = await sendMessage<NativeStatusReply>(MessageType.NATIVE_STATUS, { force }).catch(() => null);
  const details = $<HTMLDListElement>("native-details");
  const update = $<HTMLButtonElement>("native-update");
  if (status?.installed && status.pong) {
    chip.className = "chip on";
    chip.textContent = t("nativeOn");
    details.hidden = false;
    update.hidden = false;
    $("ytdlp-version").textContent = status.pong.ytdlpVersion ?? "—";
    $("host-version").textContent = status.pong.hostVersion;
    $("ffmpeg-state").textContent = status.pong.ffmpeg ? t("present") : t("missing");
    $("deno-state").textContent = status.pong.deno ? t("present") : t("missing");
    $("download-dir").textContent = status.pong.downloadDir || "—";
    const mismatch = $("native-mismatch");
    mismatch.hidden = status.pong.hostVersion === extensionVersion;
    mismatch.textContent = t("optVersionMismatch", [extensionVersion, status.pong.hostVersion]);
  } else {
    chip.className = "chip off";
    chip.textContent = t("nativeOff");
    details.hidden = true;
    update.hidden = true;
  }
}

async function showInstallSteps(): Promise<void> {
  const info = await chrome.runtime.getPlatformInfo();
  $("install-win").hidden = info.os !== "win";
  $("install-mac").hidden = info.os !== "mac";
  if (info.os !== "win" && info.os !== "mac") {
    $("install-win").hidden = false;
    $("install-mac").hidden = false;
  }
  $("ext-id").textContent = chrome.runtime.id;
}

async function loadForm(): Promise<void> {
  const reply = await sendMessage<{ data?: StorageConfig }>(MessageType.GET_CONFIG).catch(() => null);
  const s = resolveSettings(reply?.data);
  const form = $<HTMLFormElement>("form");
  const set = (name: string, value: boolean | number) => {
    const input = form.elements.namedItem(name) as HTMLInputElement;
    if (input.type === "checkbox") input.checked = value as boolean;
    else input.value = String(value);
  };
  set("askWhereToSave", s.askWhereToSave);
  set("showOverlay", s.showOverlay);
  set("notifyOnCompletion", s.notifications.notifyOnCompletion);
  set("historyEnabled", s.historyEnabled);
  set("minVideoWidth", s.minVideoWidth);
  set("maxConcurrent", s.maxConcurrent);
  set("preferNativeAboveMb", s.preferNativeAboveMb);
  set("useSiteSession", s.useSiteSession);
  set("useSiteSessionOnYoutube", s.useSiteSessionOnYoutube);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = (await sendMessage<{ data?: StorageConfig }>(MessageType.GET_CONFIG).catch(() => null))?.data ?? {};
    const bool = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;
    const int = (name: string, min: number, max: number, fallback: number) => {
      const n = Math.round(Number((form.elements.namedItem(name) as HTMLInputElement).value));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const next: StorageConfig = {
      ...current,
      askWhereToSave: bool("askWhereToSave"),
      showOverlay: bool("showOverlay"),
      historyEnabled: bool("historyEnabled"),
      useSiteSession: bool("useSiteSession"),
      useSiteSessionOnYoutube: bool("useSiteSessionOnYoutube"),
      minVideoWidth: int("minVideoWidth", 40, 2000, s.minVideoWidth),
      maxConcurrent: int("maxConcurrent", 1, 12, s.maxConcurrent),
      preferNativeAboveMb: int("preferNativeAboveMb", 100, 100000, s.preferNativeAboveMb),
      notifications: { ...current.notifications, notifyOnCompletion: bool("notifyOnCompletion") },
    };
    await sendMessage(MessageType.SAVE_CONFIG, next);
    const saved = $("saved");
    saved.textContent = t("optSaved");
    setTimeout(() => (saved.textContent = ""), 2500);
  });
}

$("native-check").addEventListener("click", () => void loadNative(true));
$("native-update").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("native-update");
  const message = $("native-message");
  button.disabled = true;
  message.textContent = t("optUpdating");
  type UpdateReply = { success: boolean; result?: { ytdlpVersion: string | null }; error?: string };
  const reply: UpdateReply = await sendMessage<UpdateReply>(MessageType.NATIVE_UPDATE).catch(
    (err): UpdateReply => ({ success: false, error: String(err) }),
  );
  button.disabled = false;
  message.textContent = reply.success
    ? t("optUpdated", reply.result?.ytdlpVersion ?? "?")
    : `${t("stageFailed")}: ${reply.error ?? ""}`;
  void loadNative(true);
});

// ---------------------------------------------------------------- diagnostic report

const diagParams = new URLSearchParams(location.search);
const diagTab = Number(diagParams.get("diag"));

async function loadDiagnostics(): Promise<void> {
  const pre = $("diag-text");
  type DiagReply = { success?: boolean; text?: string };
  const reply = await sendMessage<DiagReply>(MessageType.GET_DIAGNOSTICS, { tabId: diagTab }).catch(() => null);
  pre.textContent = reply?.text ?? t("diagUnavailable");
}

if (diagParams.has("diag") && Number.isInteger(diagTab) && diagTab >= 0) {
  $("diagnostics").hidden = false;
  $("diag-copy").addEventListener("click", async () => {
    const copied = $("diag-copied");
    try {
      await navigator.clipboard.writeText($("diag-text").textContent ?? "");
      copied.textContent = t("diagCopied");
    } catch {
      // Without clipboard access the text stays selectable in the box.
      const range = document.createRange();
      range.selectNodeContents($("diag-text"));
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
    setTimeout(() => (copied.textContent = ""), 2500);
  });
  $("diag-refresh").addEventListener("click", () => void loadDiagnostics());
  void loadDiagnostics().then(() => $("diagnostics").scrollIntoView());
}

localize();
void loadNative();
void showInstallSteps();
void loadForm();
