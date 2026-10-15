/**
 * Icons inside an iframe that the page covers.
 *
 * Sites often lay a transparent layer over an embedded player, to catch the first click for an
 * ad or to handle clicks themselves. The pointer then never reaches the iframe: the icon drawn
 * inside it can be seen, but not hovered nor clicked. So a frame tells its parent where its
 * icons and its menu are (a postMessage to the parent window; the parent finds the iframe by the
 * message's source). When the pointer reaches one of them, the parent lets the pointer through
 * whatever covers the iframe there, and puts it back once the icon is left and its menu closed.
 * Anywhere else the page keeps working as it was.
 *
 * A message faked by the page could only make the page's own layers let the pointer through for a
 * while, which the page can do anyway.
 */

export interface UiRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FrameUi {
  rects: UiRect[];
  /** The frame sees the pointer on one of its icons */
  hover: boolean;
  /** A menu is open */
  menu: boolean;
}

/** The key of the message a frame posts to its parent */
export const FRAME_UI_KEY = "video-down:frame-ui";
/**
 * The key of the message a parent posts to a child frame when the pointer left it for the parent:
 * a frame is not always told (a pointer that jumps out of an iframe), and its icon stayed unfolded.
 */
export const POINTER_LEFT_KEY = "video-down:pointer-left";

const MAX_RECTS = 24;
const LIMIT = 100_000;

/** Only plain, bounded rectangles: the message crosses frames, and the page can post one too. */
export function sanitizeFrameUi(raw: unknown): FrameUi | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { rects, hover, menu } = raw as Record<string, unknown>;
  if (!Array.isArray(rects) || rects.length > MAX_RECTS) return null;
  const clean: UiRect[] = [];
  for (const r of rects) {
    if (typeof r !== "object" || r === null) return null;
    const { left, top, width, height } = r as Record<string, unknown>;
    const nums = [left, top, width, height];
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= LIMIT)) return null;
    if ((width as number) < 0 || (height as number) < 0) return null;
    clean.push({ left: left as number, top: top as number, width: width as number, height: height as number });
  }
  return { rects: clean, hover: hover === true, menu: menu === true };
}

/**
 * Child side: post what changed to the parent window, at most every 100 ms (the last state always
 * goes out). Returns the function the overlay calls after each layout.
 */
export function uiReporter(target: Window): (ui: FrameUi) => void {
  let last = "";
  let pending: FrameUi | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const ui = pending;
    pending = null;
    const key = JSON.stringify(ui);
    if (key === last) return;
    last = key;
    try {
      target.postMessage({ [FRAME_UI_KEY]: ui }, "*");
    } catch {
      // the parent went away
    }
  };
  return (ui) => {
    pending = {
      rects: ui.rects.slice(0, MAX_RECTS).map((r) => ({
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })),
      hover: ui.hover,
      menu: ui.menu,
    };
    // The first change goes at once; the following ones, every 100 ms at most.
    if (!timer) {
      flush();
      timer = setTimeout(flush, 100);
    }
  };
}

type FrameElement = HTMLIFrameElement | HTMLFrameElement;

/** Parent side: lifts the layers over a child frame's icons while the pointer is on them. */
export class CoverLifter {
  private readonly children = new Map<Window, FrameUi>();
  /** Each lifted element and its own inline pointer-events, to put back as it was */
  private readonly lifted = new Map<HTMLElement, { value: string; priority: string }>();
  private liftedFor: Window | null = null;
  /** The child said its icon has the pointer since the layers were lifted */
  private confirmed = false;
  /** This document has the pointer, so no child frame does */
  private pointerHere = false;
  private giveUp: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    document.addEventListener("pointermove", (e) => this.onPointer(e.clientX, e.clientY), {
      capture: true,
      passive: true,
    });
    // The pointer left the window: nothing of ours can be under it.
    document.documentElement.addEventListener("pointerleave", () => this.pointerAway());
  }

  onChildUi(source: Window, ui: FrameUi): void {
    this.children.set(source, ui);
    if (this.children.size > 50) this.children.delete(this.children.keys().next().value!);
    if (this.liftedFor !== source) return;
    if (ui.hover || ui.menu) this.confirmed = true;
    // A menu just closed while the pointer is on this document, or the icon was left.
    if (!ui.menu && (this.pointerHere || (this.confirmed && !ui.hover))) this.restore();
  }

  /** The pointer is on this document, away from every child icon (or out of the window). */
  private pointerAway(): void {
    this.pointerHere = true;
    const source = this.liftedFor;
    if (!source) return;
    const ui = this.children.get(source);
    if (ui?.hover) {
      // Tell the frame: it may not have noticed the pointer leaving.
      ui.hover = false;
      try {
        source.postMessage({ [POINTER_LEFT_KEY]: true }, "*");
      } catch {
        // gone
      }
    }
    if (!ui?.menu) this.restore();
  }

  private onPointer(x: number, y: number): void {
    for (const [source, ui] of this.children) {
      if (ui.rects.length === 0) continue;
      const frame = frameOf(source);
      if (!frame) {
        if (source.closed) this.children.delete(source);
        continue;
      }
      const map = mapper(frame);
      const hit = ui.rects.some((r) => {
        const a = map(r.left, r.top);
        const b = map(r.left + r.width, r.top + r.height);
        return x >= a.x && x <= b.x && y >= a.y && y <= b.y;
      });
      if (hit) {
        this.pointerHere = false;
        this.lift(frame, source, x, y);
        return;
      }
    }
    this.pointerAway();
  }

  private lift(frame: FrameElement, source: Window, x: number, y: number): void {
    if (this.liftedFor && this.liftedFor !== source) this.restore();
    const stack = document.elementsFromPoint(x, y);
    const at = stack.indexOf(frame);
    // Not covered here (or the frame itself is not hit-testable): nothing to do.
    if (at <= 0) return;
    for (const el of stack.slice(0, at)) {
      if (!(el instanceof HTMLElement) || el.contains(frame) || this.lifted.has(el)) continue;
      if (el.tagName === "VIDEO-DOWN-OVERLAY") continue;
      this.lifted.set(el, {
        value: el.style.getPropertyValue("pointer-events"),
        priority: el.style.getPropertyPriority("pointer-events"),
      });
      el.style.setProperty("pointer-events", "none", "important");
    }
    if (this.liftedFor !== source) {
      this.liftedFor = source;
      this.confirmed = false;
    }
    // If the child never says its icon got the pointer, do not leave the page changed.
    if (this.giveUp) clearTimeout(this.giveUp);
    this.giveUp = setTimeout(() => {
      this.giveUp = null;
      if (!this.confirmed) this.restore();
    }, 2000);
  }

  private restore(): void {
    for (const [el, was] of this.lifted) {
      if (was.value) el.style.setProperty("pointer-events", was.value, was.priority);
      else el.style.removeProperty("pointer-events");
    }
    this.lifted.clear();
    this.liftedFor = null;
    this.confirmed = false;
    if (this.giveUp) clearTimeout(this.giveUp);
    this.giveUp = null;
  }
}

/** The iframe (or frame) of this document whose window is `source`. */
function frameOf(source: Window): FrameElement | null {
  for (const el of Array.from(document.querySelectorAll<FrameElement>("iframe, frame"))) {
    if (el.contentWindow === source) return el;
  }
  return null;
}

/** Child viewport coordinates → this viewport's, through the frame's border, padding and scale. */
function mapper(frame: HTMLElement): (x: number, y: number) => { x: number; y: number } {
  const box = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  const sx = frame.offsetWidth > 0 ? box.width / frame.offsetWidth : 1;
  const sy = frame.offsetHeight > 0 ? box.height / frame.offsetHeight : 1;
  const ox = box.left + (frame.clientLeft + (parseFloat(style.paddingLeft) || 0)) * sx;
  const oy = box.top + (frame.clientTop + (parseFloat(style.paddingTop) || 0)) * sy;
  return (x, y) => ({ x: ox + x * sx, y: oy + y * sy });
}
