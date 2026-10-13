/**
 * The download icon drawn over the top-left corner of every <video>, and the
 * menu that lists the available resolutions.
 *
 * Everything lives in one closed shadow root attached to <html>, positioned
 * with `position: fixed` from each video's bounding box. Nothing is inserted
 * inside the page's own player markup.
 */

import { OVERLAY_CSS, DOWNLOAD_ICON, LOCK_ICON } from "./styles";
import { t, formatBytes, formatEta } from "../../shared/i18n";
import { route, type Route, type RouteInput, type DirectSource } from "../../core/router";
import { bindMedia } from "../../core/binding";
import { readFacts, pageTitle, DRM_ATTR } from "../video-facts";
import {
  MessageType,
  type DownloadRequestPayload,
  type DownloadStartedReply,
  type GetVariantsReply,
  type NativeProbeReply,
  type NativeDownloadPayload,
  type ProgressPush,
} from "../../shared/messages";
import { DownloadStage, VideoFormat, type VideoMetadata, type DownloadProgress } from "../../core/types";
import type { BrowserVariant } from "../../core/variants";
import type { Variant as NativeVariant } from "@host/protocol";
import { type DetectionFailure, redactUrl } from "../../core/detection/detection-failure";

declare const __VD_SHADOW_MODE__: ShadowRootMode;

export interface OverlayDeps {
  /** Every media item detected in this frame so far */
  allMedia(): VideoMetadata[];
  isNativeAvailable(): Promise<boolean>;
  minVideoWidth: number;
  /** Manifests seen in this frame that could not be read, newest first */
  failures(): DetectionFailure[];
  /** Read those manifests again (e.g. after the player refreshed its token) */
  retryFailed(): void;
  /** The playlist as the page's player received it, if the frame has a copy */
  bodyFor(url: string): string | undefined;
  /**
   * A video (re)started loading. `previous` is what was bound to it until now; after an
   * address change, whatever of that is old belonged to the previous video.
   */
  onVideoLoad(previous: VideoMetadata[]): void;
  /** Note for the diagnostic report */
  note?(event: string, url?: string, detail?: string): void;
}

interface JobView {
  id: string;
  label: string;
  via: "browser" | "native";
  progress?: DownloadProgress;
  filePath?: string;
}

interface Tracked {
  key: string;
  video: HTMLVideoElement;
  trigger: HTMLButtonElement;
  ring: HTMLSpanElement;
  firstSeenAt: number;
  loadStartedAt: number;
  jobs: Map<string, JobView>;
  visible: boolean;
}

/** Choice shown in the menu, already resolved to what the click must do. */
type Choice =
  | { kind: "browser"; label: string; meta: string; payload: DownloadRequestPayload }
  | { kind: "native"; label: string; meta: string; payload: NativeDownloadPayload };

const MIN_VIDEO_HEIGHT = 60;
const OFFSET = 8;
const FINISHED = new Set<DownloadStage>([DownloadStage.COMPLETED, DownloadStage.FAILED, DownloadStage.CANCELLED]);

function send<T>(type: MessageType, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (reply: T) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(reply);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  for (const c of children) node.appendChild(c);
  return node;
}

function metaFor(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

/** Short, readable error: no raw URLs (they can be kilobytes of signed tokens). */
function friendlyError(message: string | undefined): string {
  if (!message) return "";
  return message.replace(/https?:\/\/\S+/g, (u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  }).slice(0, 300);
}

function referrerForNative(): string | undefined {
  // Embedded players (Vimeo, etc.) often require the embedding page as Referer.
  if (window.self === window.top) return undefined;
  const ref = document.referrer;
  return ref.startsWith("http://") || ref.startsWith("https://") ? ref : undefined;
}

export class Overlay {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly popover: HTMLDivElement;
  private readonly tracked = new Map<string, Tracked>();
  private readonly byVideo = new WeakMap<HTMLVideoElement, Tracked>();
  private readonly resizeObserver: ResizeObserver;
  private mutationObserver: MutationObserver | null = null;
  private layoutQueued = false;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private counter = 0;
  private openKey: string | null = null;
  private renderToken = 0;
  private lastRoute: Route | null = null;
  private pendingRetry: ReturnType<typeof setTimeout> | null = null;
  private pointer = { x: -1, y: -1 };
  private readonly cache = new Map<string, Promise<unknown>>();
  /**
   * Progress for jobs this frame does not know yet. A small or local file can finish before the
   * reply that names its job arrives here; that last update must not be lost.
   */
  private readonly earlyProgress = new Map<string, { push: ProgressPush; at: number }>();

  constructor(private readonly deps: OverlayDeps) {
    this.host = document.createElement("video-down-overlay");
    // Closed in production so pages cannot reach the UI; the e2e build opens it for Playwright.
    this.root = this.host.attachShadow({ mode: __VD_SHADOW_MODE__ });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    this.root.appendChild(style);
    this.popover = el("div", {
      className: "vd-popover",
      attrs: { role: "dialog", "aria-modal": "false", "aria-label": t("menuTitle") },
    });
    this.popover.hidden = true;
    this.root.appendChild(this.popover);
    this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    this.attachHost();
    this.scan();
    this.mutationObserver = new MutationObserver(() => this.scheduleScan());
    this.mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

    const onViewportChange = () => this.scheduleLayout();
    window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange, { passive: true });
    document.addEventListener("fullscreenchange", () => {
      this.attachHost();
      this.scheduleLayout();
    });
    document.addEventListener(
      "pointermove",
      (e) => {
        this.pointer = { x: e.clientX, y: e.clientY };
        this.scheduleLayout();
      },
      { passive: true, capture: true },
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.openKey) this.close(true);
    }, true);
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.openKey) return;
        if (e.composedPath().includes(this.host)) return;
        this.close(false);
      },
      true,
    );
    // Some layouts move videos without resizing them (carousels, sticky players).
    this.intervalId = setInterval(() => this.scheduleLayout(), 750);
  }

  /** Called when the media list of the frame changes. */
  onMediaChanged(): void {
    const tr = this.openKey ? this.tracked.get(this.openKey) : undefined;
    if (!tr) return;
    // A manifest that arrives late can turn "waiting" or "unknown stream" into a browser download.
    const r = this.lastRoute;
    const reroute =
      r?.kind === "pending" ||
      ((r?.kind === "native" || r?.kind === "need-native") && r.reason === "unknown-stream");
    if (reroute) {
      void this.renderRoute(tr);
      return;
    }
    // A better playlist may arrive while the menu is open, e.g. the master of the single
    // quality on show, found a moment later: show its qualities instead.
    if (r?.kind === "manifest") {
      const next = route(this.routeInput(tr));
      if (next.kind !== "manifest" || next.media.url !== r.media.url) void this.renderRoute(tr);
    }
  }

  /** Called when the page navigates inside a single-page app. */
  onNavigation(): void {
    this.cache.clear();
    if (this.openKey) this.close(false);
  }

  onProgress(push: ProgressPush): void {
    let known = false;
    for (const tr of this.tracked.values()) {
      const job = tr.jobs.get(push.id);
      if (!job) continue;
      known = true;
      this.applyProgress(tr, job, push);
    }
    if (known) return;
    const now = Date.now();
    for (const [id, item] of this.earlyProgress) if (now - item.at > 60_000) this.earlyProgress.delete(id);
    if (this.earlyProgress.size < 50) this.earlyProgress.set(push.id, { push, at: now });
  }

  private applyProgress(tr: Tracked, job: JobView, push: ProgressPush): void {
    job.progress = push.progress;
    if (push.via) job.via = push.via;
    if (push.filePath) job.filePath = push.filePath;
    if (push.label) job.label = push.label;
    this.updateRing(tr);
    if (this.openKey === tr.key) this.renderJobs(tr);
  }

  // ------------------------------------------------------------ discovery

  private attachHost(): void {
    // In fullscreen only the fullscreen element's subtree is painted.
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  }

  private scheduleScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, 300);
  }

  private findVideos(): HTMLVideoElement[] {
    const found: HTMLVideoElement[] = Array.from(document.querySelectorAll("video"));
    // Players built with web components keep <video> inside open shadow roots.
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let visited = 0;
    for (let n = walker.nextNode(); n && visited < 5000; n = walker.nextNode(), visited++) {
      const sr = (n as Element).shadowRoot;
      if (sr && n !== this.host) found.push(...Array.from(sr.querySelectorAll("video")));
    }
    return found;
  }

  private scan(): void {
    const videos = new Set(this.findVideos());
    for (const video of videos) {
      if (!this.byVideo.has(video)) this.track(video);
    }
    for (const tr of [...this.tracked.values()]) {
      if (!videos.has(tr.video) || !tr.video.isConnected) this.untrack(tr);
    }
    this.scheduleLayout();
  }

  private track(video: HTMLVideoElement): void {
    const key = `v${++this.counter}`;
    const trigger = el("button", {
      className: "vd-trigger",
      attrs: {
        type: "button",
        "aria-label": t("triggerLabel"),
        title: t("triggerLabel"),
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
      },
    });
    trigger.innerHTML = DOWNLOAD_ICON;
    const ring = el("span", { className: "vd-ring", attrs: { "aria-hidden": "true" } });
    trigger.appendChild(ring);
    trigger.style.display = "none";
    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.openKey === key) this.close(true);
      else void this.open(key);
    });
    this.root.insertBefore(trigger, this.popover);

    const tr: Tracked = {
      key,
      video,
      trigger,
      ring,
      firstSeenAt: Date.now(),
      loadStartedAt: 0,
      jobs: new Map(),
      visible: false,
    };
    const onLoadStart = () => {
      const previous = this.mediaFor(tr);
      tr.loadStartedAt = Date.now();
      this.deps.onVideoLoad(previous);
    };
    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("emptied", onLoadStart);
    video.addEventListener("video-down:drm", () => {
      this.updateDrmState(tr);
      if (this.openKey === key) void this.renderRoute(tr);
    });
    this.updateDrmState(tr);
    this.tracked.set(key, tr);
    this.byVideo.set(video, tr);
    this.resizeObserver.observe(video);
    // A player created after an address change may have started loading before it was found.
    if (video.currentSrc || video.networkState !== HTMLMediaElement.NETWORK_EMPTY) {
      this.deps.onVideoLoad(this.mediaFor(tr));
    }
  }

  private untrack(tr: Tracked): void {
    if (this.openKey === tr.key) this.close(false);
    this.resizeObserver.unobserve(tr.video);
    tr.trigger.remove();
    this.tracked.delete(tr.key);
    this.byVideo.delete(tr.video);
  }

  private updateDrmState(tr: Tracked): void {
    const drm = tr.video.getAttribute(DRM_ATTR);
    if (drm) {
      tr.trigger.dataset.state = "drm";
      tr.trigger.innerHTML = LOCK_ICON;
      tr.trigger.appendChild(tr.ring);
      tr.trigger.setAttribute("aria-label", t("triggerLabelDrm"));
      tr.trigger.title = t("triggerLabelDrm");
    }
  }

  // ------------------------------------------------------------ layout

  private scheduleLayout(): void {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.layout();
    });
  }

  private layout(): void {
    this.attachHost();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const tr of this.tracked.values()) {
      const r = tr.video.getBoundingClientRect();
      const style = getComputedStyle(tr.video);
      const visible =
        r.width >= this.deps.minVideoWidth &&
        r.height >= MIN_VIDEO_HEIGHT &&
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < vh &&
        r.left < vw &&
        style.visibility !== "hidden" &&
        style.display !== "none";
      tr.visible = visible || this.openKey === tr.key;
      if (!tr.visible) {
        tr.trigger.style.display = "none";
        continue;
      }
      const left = Math.min(Math.max(r.left, 0) + OFFSET, vw - 42);
      const top = Math.min(Math.max(r.top, 0) + OFFSET, vh - 42);
      tr.trigger.style.display = "grid";
      tr.trigger.style.left = `${left}px`;
      tr.trigger.style.top = `${top}px`;
      const hot =
        this.pointer.x >= r.left && this.pointer.x <= r.right && this.pointer.y >= r.top && this.pointer.y <= r.bottom;
      tr.trigger.classList.toggle("vd-hot", hot || tr.jobs.size > 0);
    }
    if (this.openKey) this.positionPopover();
  }

  private positionPopover(): void {
    const tr = this.openKey ? this.tracked.get(this.openKey) : undefined;
    if (!tr) return;
    const b = tr.trigger.getBoundingClientRect();
    const pw = this.popover.offsetWidth || 300;
    const ph = this.popover.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = b.left;
    let top = b.bottom + 6;
    if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
    if (top + ph > vh - 8) top = Math.max(8, b.top - ph - 6);
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  private updateRing(tr: Tracked): void {
    const active = [...tr.jobs.values()].find((j) => !j.progress || !FINISHED.has(j.progress.stage));
    if (!active) {
      tr.ring.style.background = "";
      return;
    }
    const p = active.progress?.percentage ?? 0;
    tr.ring.style.background = `conic-gradient(#60a5fa ${p}%, transparent 0)`;
    tr.ring.style.setProperty(
      "-webkit-mask",
      "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))",
    );
    tr.ring.style.borderRadius = "50%";
  }

  // ------------------------------------------------------------ menu

  private async open(key: string): Promise<void> {
    const tr = this.tracked.get(key);
    if (!tr) return;
    if (this.openKey) this.close(false);
    this.openKey = key;
    tr.trigger.setAttribute("aria-expanded", "true");
    this.popover.hidden = false;
    this.scheduleLayout();
    await this.renderRoute(tr);
  }

  private close(restoreFocus: boolean): void {
    const tr = this.openKey ? this.tracked.get(this.openKey) : undefined;
    this.openKey = null;
    this.lastRoute = null;
    this.renderToken++;
    if (this.pendingRetry) clearTimeout(this.pendingRetry);
    this.popover.hidden = true;
    this.popover.replaceChildren();
    if (tr) {
      tr.trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) tr.trigger.focus();
    }
  }

  private frame(title: string, body: Node[]): void {
    const close = el("button", {
      className: "vd-close",
      text: "×",
      attrs: { type: "button", "aria-label": t("close") },
    });
    close.addEventListener("click", () => this.close(true));
    const header = el("div", { className: "vd-header" }, [
      el("p", { className: "vd-title", text: title }),
      close,
    ]);
    const jobs = el("div", { attrs: { "data-jobs": "" } });
    const report = el("button", { className: "vd-link vd-diag", text: t("diagLink"), attrs: { type: "button" } });
    report.addEventListener("click", () => void send(MessageType.OPEN_DIAGNOSTICS).catch(() => undefined));
    const footer = el("div", { className: "vd-foot" }, [report]);
    this.popover.replaceChildren(header, ...body, jobs, footer);
    const tr = this.openKey ? this.tracked.get(this.openKey) : undefined;
    if (tr) this.renderJobs(tr);
    this.positionPopover();
  }

  private renderLoading(message: string): void {
    this.frame(t("menuTitle"), [
      el("p", { className: "vd-muted", text: message }),
      el("div", { className: "vd-progress vd-indeterminate" }, [el("span")]),
    ]);
  }

  /** What the router needs for a video, as if the native component were missing. */
  private routeInput(tr: Tracked): RouteInput {
    return {
      pageUrl: location.href,
      video: readFacts(tr.video, tr.loadStartedAt, tr.firstSeenAt),
      media: this.mediaFor(tr),
      nativeAvailable: false,
    };
  }

  private mediaFor(tr: Tracked): VideoMetadata[] {
    const timings = [...this.tracked.values()].map((x) => ({ key: x.key, loadStartedAt: x.loadStartedAt }));
    return bindMedia(timings, this.deps.allMedia()).get(tr.key) ?? [];
  }

  private async renderRoute(tr: Tracked): Promise<void> {
    const token = ++this.renderToken;
    if (this.pendingRetry) clearTimeout(this.pendingRetry);
    if (!this.lastRoute) this.renderLoading(t("searching"));

    // Route first as if the native component were missing: direct files, HLS and DASH
    // never wait for it. Ask for its status (it may start a process) only when needed.
    const input = this.routeInput(tr);
    let r = route(input);
    let nativeAvailable = false;
    if (r.kind === "need-native") {
      nativeAvailable = await this.deps.isNativeAvailable().catch(() => false);
      if (token !== this.renderToken) return;
      if (nativeAvailable) r = route({ ...input, nativeAvailable });
    }
    if (r.kind !== this.lastRoute?.kind) {
      const counts = input.media.map((m) => m.format).join("+") || "none";
      this.deps.note?.("menu", r.kind === "manifest" ? r.media.url : undefined, `${r.kind}; media: ${counts}`);
    }
    this.lastRoute = r;

    // A manifest was seen but could not be read: say why, instead of waiting forever or
    // handing the page to yt-dlp blindly (which rarely knows an embedded player's page).
    const unreadable =
      r.kind === "pending" ||
      ((r.kind === "native" || r.kind === "need-native") && r.reason === "unknown-stream");
    const failures = unreadable ? this.deps.failures() : [];
    if (failures.length > 0) {
      const native = r.kind === "native" || (await this.deps.isNativeAvailable().catch(() => false));
      if (token !== this.renderToken) return;
      return this.renderFailure(tr, failures[0]!, native);
    }

    switch (r.kind) {
      case "pending":
        this.renderLoading(t("waitingForVideo"));
        this.pendingRetry = setTimeout(() => {
          if (this.openKey === tr.key) void this.renderRoute(tr);
        }, 1000);
        return;
      case "drm":
        return this.renderDrm(r.system);
      case "live":
        return this.renderNotice(t("liveTitle"), t("liveBody"));
      case "need-native":
        return this.renderNeedNative(r.reason);
      case "direct":
        return this.renderDirect(tr, r.sources, token);
      case "manifest":
        return this.renderManifest(tr, r.media, token, nativeAvailable);
      case "native":
        return this.renderNative(tr, r.url, r.reason === "youtube" ? undefined : referrerForNative(), token);
    }
  }

  private failureReason(failure: DetectionFailure): string {
    if (failure.reason === "http") return t("failHttp", String(failure.status ?? "?"));
    if (failure.reason === "network") return t("failNetwork");
    if (failure.body === "binary") return t("failOpaque");
    if (failure.body === "html") return t("failHtml");
    if (failure.body === "json") return t("failJson");
    return t("failOther");
  }

  /** Under the choices: other playlists of the page could not be read (e.g. a master with more qualities). */
  private appendFailureNote(exceptUrl: string): void {
    const others = this.deps.failures().filter((f) => f.url !== exceptUrl);
    if (others.length === 0) return;
    const f = others[0]!;
    const jobs = this.popover.querySelector("[data-jobs]");
    const note = el("div", { className: "vd-note" }, [
      el("p", { className: "vd-muted", text: t("otherListsFailed", String(others.length)) }),
      el("p", { className: "vd-path", text: `${redactUrl(f.url)} · ${this.failureReason(f)}` }),
    ]);
    this.popover.insertBefore(note, jobs);
  }

  private renderFailure(tr: Tracked, failure: DetectionFailure, nativeAvailable: boolean): void {
    const reason = this.failureReason(failure);

    const body: Node[] = [
      el("div", { className: "vd-notice", attrs: { role: "alert" } }, [
        el("strong", { text: t("failTitle") }),
        el("span", { text: reason }),
      ]),
      el("p", { className: "vd-path", text: t("failWhere", redactUrl(failure.url)) }),
    ];
    const retry = el("button", { className: "vd-action vd-secondary", text: t("retry"), attrs: { type: "button" } });
    retry.addEventListener("click", () => {
      this.deps.retryFailed();
      this.lastRoute = null;
      this.renderLoading(t("searching"));
      // Detection reports back through onMediaChanged(); re-route anyway after a moment.
      setTimeout(() => {
        if (this.openKey === tr.key) void this.renderRoute(tr);
      }, 2500);
    });
    body.push(retry);
    if (nativeAvailable && failure.body !== "binary") {
      const native = el("button", { className: "vd-action", text: t("tryNative"), attrs: { type: "button" } });
      native.addEventListener("click", () => void this.renderNative(tr, failure.url, location.href, ++this.renderToken));
      body.push(el("span", { text: " " }), native);
    }
    this.frame(t("menuTitle"), body);
  }

  private renderDrm(system?: string): void {
    const notice = el("div", { className: "vd-notice", attrs: { role: "alert" } }, [
      el("strong", { text: system && system !== "EME" ? t("drmTitleWith", system) : t("drmTitle") }),
      el("span", { text: t("drmBody") }),
    ]);
    this.frame(t("menuTitle"), [notice, el("p", { className: "vd-muted", text: t("drmHint") })]);
  }

  private renderNotice(title: string, body: string): void {
    this.frame(t("menuTitle"), [
      el("div", { className: "vd-notice" }, [el("strong", { text: title }), el("span", { text: body })]),
    ]);
  }

  private renderNeedNative(reason: "youtube" | "unknown-stream"): void {
    const action = el("button", { className: "vd-action", text: t("howToInstall"), attrs: { type: "button" } });
    action.addEventListener("click", () => void send(MessageType.OPEN_OPTIONS, { section: "native" }));
    this.frame(t("menuTitle"), [
      el("div", { className: "vd-notice" }, [
        el("strong", { text: t("needNativeTitle") }),
        el("span", { text: reason === "youtube" ? t("needNativeYoutube") : t("needNativeStream") }),
      ]),
      action,
    ]);
  }

  private renderError(message: string, retry?: () => void, nativeFallback?: () => void): void {
    const body: Node[] = [el("p", { className: "vd-error", text: message, attrs: { role: "alert" } })];
    if (retry) {
      const b = el("button", { className: "vd-action vd-secondary", text: t("retry"), attrs: { type: "button" } });
      b.addEventListener("click", retry);
      body.push(b);
    }
    if (nativeFallback) {
      const b = el("button", { className: "vd-action", text: t("tryNative"), attrs: { type: "button" } });
      b.addEventListener("click", nativeFallback);
      body.push(el("span", { text: " " }), b);
    }
    this.frame(t("menuTitle"), body);
  }

  private renderChoices(title: string, intro: string | null, choices: Choice[]): void {
    const list = el("ul", { className: "vd-list" });
    for (const choice of choices) {
      const button = el("button", { className: "vd-option", attrs: { type: "button" } }, [
        el("span", { className: "vd-option-main", text: choice.label }),
        el("span", { className: "vd-option-meta", text: choice.meta }),
      ]);
      button.addEventListener("click", () => void this.begin(choice, button));
      list.appendChild(el("li", {}, [button]));
    }
    const body: Node[] = [];
    if (intro) body.push(el("p", { className: "vd-muted", text: intro }));
    body.push(list);
    this.frame(title, body);
    (list.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  // ---- direct files

  private async renderDirect(tr: Tracked, sources: DirectSource[], token: number): Promise<void> {
    const reply = await this.cached(`direct:${sources.map((s) => s.url).join("|")}`, () =>
      send<GetVariantsReply>(MessageType.GET_VARIANTS, {
        url: sources[0]!.url,
        format: VideoFormat.DIRECT,
        sources: sources.map((s) => s.url),
      }),
    ).catch(() => null);
    if (token !== this.renderToken) return;
    const sizes = new Map<string, number>();
    for (const v of reply?.variants ?? []) if (v.approxBytes) sizes.set(v.id, v.approxBytes);

    const playing = tr.video.currentSrc;
    const title = pageTitle();
    const choices: Choice[] = sources.map((s, i) => {
      const height = s.height ?? (s.url === playing && tr.video.videoHeight ? tr.video.videoHeight : undefined);
      const label = height ? `${height}p` : s.label || (sources.length > 1 ? t("fileN", String(i + 1)) : t("originalFile"));
      const ext = (s.url.split("?")[0]!.split(".").pop() || "").toUpperCase();
      return {
        kind: "browser",
        label,
        meta: metaFor([ext.length <= 4 ? ext : undefined, formatBytes(sizes.get(s.url))]),
        payload: {
          url: s.url,
          metadata: { url: s.url, format: VideoFormat.DIRECT, pageUrl: location.href, title },
          tabTitle: title,
          website: location.hostname,
          variantLabel: label,
          ...(height ? { variantHeight: height } : {}),
        },
      };
    });
    this.renderChoices(t("chooseQuality"), null, choices);
  }

  // ---- HLS / DASH in the browser

  private async renderManifest(
    tr: Tracked,
    media: VideoMetadata,
    token: number,
    nativeAvailable: boolean,
  ): Promise<void> {
    const duration = Number.isFinite(tr.video.duration) ? tr.video.duration : undefined;
    let reply: GetVariantsReply;
    try {
      reply = await this.cached(`manifest:${media.url}`, () => {
        const text = this.deps.bodyFor(media.url);
        return send<GetVariantsReply>(MessageType.GET_VARIANTS, {
          url: media.url,
          format: media.format,
          duration,
          ...(text ? { text } : {}),
        });
      });
    } catch (err) {
      reply = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (token !== this.renderToken) return;
    if (!reply.success || !reply.variants?.length) {
      const canFallback = nativeAvailable || (await this.deps.isNativeAvailable().catch(() => false));
      if (token !== this.renderToken) return;
      this.renderError(
        friendlyError(reply.error) || t("noVariants"),
        () => {
          this.cache.delete(`manifest:${media.url}`);
          void this.renderRoute(tr);
        },
        canFallback ? () => void this.renderNative(tr, media.url, location.href, ++this.renderToken) : undefined,
      );
      return;
    }
    const title = pageTitle();
    const kind = media.format === VideoFormat.DASH ? "DASH" : "HLS";
    const choices: Choice[] = reply.variants.map((v: BrowserVariant) => {
      const label = v.label === "original" ? t("originalFile") : v.label;
      return {
        kind: "browser",
        label,
        meta: metaFor([formatBytes(v.approxBytes) ? `~${formatBytes(v.approxBytes)}` : undefined, kind]),
        payload: {
          url: media.url,
          metadata: { ...media, title },
          tabTitle: title,
          website: location.hostname,
          variantLabel: label,
          ...(v.manifestQuality ? { manifestQuality: v.manifestQuality } : {}),
          ...(v.height ? { variantHeight: v.height } : {}),
          ...(v.approxBytes ? { approxBytes: v.approxBytes } : {}),
        },
      };
    });
    this.renderChoices(t("chooseQuality"), null, choices);
    this.appendFailureNote(media.url);
  }

  // ---- native component (yt-dlp)

  private async renderNative(tr: Tracked, url: string, referer: string | undefined, token: number): Promise<void> {
    this.renderLoading(t("askingNative"));
    let reply: NativeProbeReply;
    try {
      reply = await this.cached(`native:${url}`, () =>
        send<NativeProbeReply>(MessageType.NATIVE_PROBE, referer ? { url, referer } : { url }),
      );
    } catch (err) {
      reply = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (token !== this.renderToken) return;
    const result = reply.result;
    if (!reply.success || !result) {
      if (reply.code === "drm") return this.renderDrm();
      this.cache.delete(`native:${url}`);
      if (reply.code === "unsupported-url") {
        // yt-dlp does not know this page. The player may still request its playlist later
        // (e.g. after pressing play), so "retry" searches the page again instead of re-asking yt-dlp.
        this.renderError(t("nativeUnsupported"), () => {
          this.lastRoute = null;
          void this.renderRoute(tr);
        });
        return;
      }
      this.renderError(friendlyError(reply.error) || t("nativeFailed"), () => {
        void this.renderNative(tr, url, referer, ++this.renderToken);
      });
      return;
    }
    if (result.drm) return this.renderDrm();
    if (result.isLive) return this.renderNotice(t("liveTitle"), t("liveBody"));
    if (result.variants.length === 0) return this.renderError(t("noVariants"));

    const choices: Choice[] = result.variants.map((v: NativeVariant) => {
      const label = v.id === "best" ? t("bestQuality") : v.label;
      return {
        kind: "native",
        label,
        meta: metaFor([v.vcodec, v.approxBytes ? `~${formatBytes(v.approxBytes)}` : undefined]),
        payload: {
          probeId: result.probeId,
          variantId: v.id,
          title: result.title,
          label,
          pageUrl: location.href,
        },
      };
    });
    this.renderChoices(result.title, t("viaNative"), choices);
  }

  // ------------------------------------------------------------ downloads

  private async begin(choice: Choice, button: HTMLButtonElement): Promise<void> {
    const tr = this.openKey ? this.tracked.get(this.openKey) : undefined;
    if (!tr) return;
    button.disabled = true;
    try {
      const reply =
        choice.kind === "browser"
          ? await send<DownloadStartedReply>(MessageType.DOWNLOAD_REQUEST, choice.payload)
          : await send<DownloadStartedReply>(MessageType.NATIVE_DOWNLOAD, choice.payload);
      if (!reply?.success || !reply.downloadId) {
        throw new Error(reply?.error || t("downloadFailed"));
      }
      const job: JobView = {
        id: reply.downloadId,
        label: choice.label,
        via: reply.via ?? (choice.kind === "native" ? "native" : "browser"),
      };
      tr.jobs.set(reply.downloadId, job);
      const early = this.earlyProgress.get(reply.downloadId);
      this.earlyProgress.delete(reply.downloadId);
      if (early) this.applyProgress(tr, job, early.push);
      this.updateRing(tr);
      this.renderJobs(tr);
    } catch (err) {
      button.disabled = false;
      const msg = err instanceof Error ? err.message : String(err);
      const jobs = this.popover.querySelector("[data-jobs]");
      jobs?.replaceChildren(el("p", { className: "vd-error", text: msg, attrs: { role: "alert" } }));
    }
  }

  private renderJobs(tr: Tracked): void {
    const container = this.popover.querySelector("[data-jobs]");
    if (!container) return;
    const nodes: Node[] = [];
    for (const job of [...tr.jobs.values()].reverse()) nodes.push(this.jobNode(job));
    container.replaceChildren(...nodes);
    this.positionPopover();
  }

  private jobNode(job: JobView): Node {
    const p = job.progress;
    const stage = p?.stage ?? DownloadStage.DETECTING;
    const pct = typeof p?.percentage === "number" ? Math.max(0, Math.min(100, p.percentage)) : undefined;

    let status: string;
    let statusClass = "vd-muted";
    switch (stage) {
      case DownloadStage.COMPLETED:
        status = t("stageDone");
        statusClass = "vd-ok";
        break;
      case DownloadStage.FAILED:
        status = p?.error ? `${t("stageFailed")}: ${p.error}` : t("stageFailed");
        statusClass = "vd-error";
        break;
      case DownloadStage.CANCELLED:
        status = t("stageCancelled");
        break;
      case DownloadStage.MERGING:
        status = t("stageMerging");
        break;
      case DownloadStage.SAVING:
        status = t("stageSaving");
        break;
      case DownloadStage.DOWNLOADING: {
        const bits = [pct !== undefined ? `${Math.round(pct)}%` : undefined];
        if (p?.downloaded && p?.total) bits.push(`${formatBytes(p.downloaded)} / ${formatBytes(p.total)}`);
        if (p?.eta) bits.push(formatEta(p.eta));
        status = metaFor([t("stageDownloading"), ...bits]);
        break;
      }
      default:
        status = p?.message === "native-fallback" ? t("retryingNative") : t("stageStarting");
    }

    const bar = el("div", {
      className: `vd-progress${pct === undefined && !FINISHED.has(stage) ? " vd-indeterminate" : ""}`,
      attrs: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        ...(pct !== undefined ? { "aria-valuenow": String(Math.round(pct)) } : {}),
      },
    }, [el("span")]);
    const fill = bar.firstChild as HTMLSpanElement;
    if (pct !== undefined) fill.style.width = `${pct}%`;
    if (stage === DownloadStage.COMPLETED) fill.style.width = "100%";

    const row = el("div", { className: "vd-job-row" }, [
      el("span", { className: "vd-option-main", text: job.label }),
      el("span", { className: "vd-option-meta", text: job.via === "native" ? "yt-dlp" : t("viaBrowser") }),
    ]);
    const nodes: Node[] = [row, bar, el("p", { className: statusClass, text: status, attrs: { "aria-live": "polite" } })];

    if (!FINISHED.has(stage) && stage !== DownloadStage.MERGING && stage !== DownloadStage.SAVING) {
      const cancel = el("button", { className: "vd-link", text: t("cancel"), attrs: { type: "button" } });
      cancel.addEventListener("click", () => void send(MessageType.CANCEL_DOWNLOAD, { id: job.id }));
      nodes.push(cancel);
    }
    if (stage === DownloadStage.COMPLETED) {
      if (job.via === "browser") {
        const show = el("button", { className: "vd-link", text: t("showInFolder"), attrs: { type: "button" } });
        show.addEventListener("click", () => void send(MessageType.SHOW_DOWNLOAD, { id: job.id }));
        nodes.push(show);
      } else if (job.filePath) {
        nodes.push(el("p", { className: "vd-path", text: job.filePath }));
      }
    }
    return el("div", { className: "vd-job" }, nodes);
  }
}
