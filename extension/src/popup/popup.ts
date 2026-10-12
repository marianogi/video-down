/**
 * Toolbar popup: state of the native component and the list of downloads.
 * Starting a download happens from the icon over each video, not from here.
 */

import { h, localize, sendMessage } from "../ui/dom";
import { t, formatBytes, formatEta } from "../shared/i18n";
import { MessageType, type NativeStatusReply, type ProgressPush } from "../shared/messages";
import { DownloadStage, type DownloadState } from "../core/types";

const list = document.getElementById("list") as HTMLUListElement;
const empty = document.getElementById("empty") as HTMLParagraphElement;
const nativeChip = document.getElementById("native") as HTMLSpanElement;
const items = new Map<string, DownloadState>();

const FINISHED = new Set([DownloadStage.COMPLETED, DownloadStage.FAILED, DownloadStage.CANCELLED]);

function stageText(d: DownloadState): { text: string; cls: string } {
  const p = d.progress;
  switch (p.stage) {
    case DownloadStage.COMPLETED:
      return { text: t("stageDone"), cls: "ok" };
    case DownloadStage.FAILED:
      return { text: p.error ? `${t("stageFailed")}: ${p.error}` : t("stageFailed"), cls: "error" };
    case DownloadStage.CANCELLED:
      return { text: t("stageCancelled"), cls: "muted" };
    case DownloadStage.MERGING:
      return { text: t("stageMerging"), cls: "muted" };
    case DownloadStage.SAVING:
      return { text: t("stageSaving"), cls: "muted" };
    case DownloadStage.DOWNLOADING: {
      const bits = [t("stageDownloading")];
      if (typeof p.percentage === "number") bits.push(`${Math.round(p.percentage)}%`);
      if (p.downloaded && p.total) bits.push(`${formatBytes(p.downloaded)} / ${formatBytes(p.total)}`);
      if (p.eta) bits.push(formatEta(p.eta));
      return { text: bits.join(" · "), cls: "muted" };
    }
    default:
      return { text: t("stageStarting"), cls: "muted" };
  }
}

function itemNode(d: DownloadState): HTMLLIElement {
  const status = stageText(d);
  const pct = d.progress.stage === DownloadStage.COMPLETED ? 100 : (d.progress.percentage ?? 0);
  const bar = h("div", {
    className: "progress",
    attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)) },
  }, [h("span")]);
  (bar.firstChild as HTMLSpanElement).style.width = `${pct}%`;

  const actions = h("div", { className: "item-actions" });
  if (!FINISHED.has(d.progress.stage) && d.progress.stage !== DownloadStage.MERGING && d.progress.stage !== DownloadStage.SAVING) {
    const cancel = h("button", { className: "link", text: t("cancel"), attrs: { type: "button" } });
    cancel.addEventListener("click", () => void sendMessage(MessageType.CANCEL_DOWNLOAD, { id: d.id }));
    actions.append(cancel);
  }
  if (d.progress.stage === DownloadStage.COMPLETED && d.via !== "native" && d.chromeDownloadId != null) {
    const show = h("button", { className: "link", text: t("showInFolder"), attrs: { type: "button" } });
    show.addEventListener("click", () => void sendMessage(MessageType.SHOW_DOWNLOAD, { id: d.id }));
    actions.append(show);
  }

  const children: Node[] = [
    h("p", { className: "item-title", text: d.metadata.title || d.url, attrs: { title: d.metadata.title || d.url } }),
    h("p", {
      className: "item-meta",
      text: [d.variantLabel, d.via === "native" ? "yt-dlp" : t("viaBrowser"), new Date(d.createdAt).toLocaleString()]
        .filter(Boolean)
        .join(" · "),
    }),
    bar,
    h("p", { className: `item-status ${status.cls}`, text: status.text }),
  ];
  if (d.progress.stage === DownloadStage.COMPLETED && d.via === "native" && d.localPath) {
    children.push(h("p", { className: "path", text: d.localPath }));
  }
  if (actions.childElementCount) children.push(actions);
  return h("li", { className: "item" }, children);
}

function render(): void {
  const sorted = [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  list.replaceChildren(...sorted.map(itemNode));
  empty.hidden = sorted.length > 0;
}

async function load(): Promise<void> {
  const reply = await sendMessage<{ success: boolean; data?: DownloadState[] }>(MessageType.GET_DOWNLOADS).catch(() => null);
  items.clear();
  for (const d of reply?.data ?? []) items.set(d.id, d);
  render();
}

async function loadNative(): Promise<void> {
  nativeChip.textContent = t("nativeChecking");
  const status = await sendMessage<NativeStatusReply>(MessageType.NATIVE_STATUS).catch(() => null);
  if (status?.installed) {
    nativeChip.className = "chip on";
    nativeChip.textContent = t("nativeOn");
    nativeChip.title = `yt-dlp ${status.pong?.ytdlpVersion ?? ""}`;
  } else {
    nativeChip.className = "chip off";
    nativeChip.textContent = t("nativeOff");
    nativeChip.title = t("needNativeTitle");
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== MessageType.DOWNLOAD_PROGRESS) return false;
  const push = message.payload as ProgressPush;
  const existing = items.get(push.id);
  if (existing) {
    existing.progress = push.progress;
    existing.updatedAt = Date.now();
    if (push.filePath) existing.localPath = push.filePath;
    render();
  } else {
    void load();
  }
  return false;
});

document.getElementById("clear")!.addEventListener("click", async () => {
  await sendMessage(MessageType.CLEAR_DOWNLOADS).catch(() => undefined);
  await load();
});
document.getElementById("options")!.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

localize();
void load();
void loadNative();
