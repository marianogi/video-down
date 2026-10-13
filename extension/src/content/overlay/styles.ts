/**
 * Styles for the overlay. They live inside a closed shadow root, so neither
 * the page's CSS nor its scripts can reach them, and they cannot leak out.
 */

export const OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0 auto auto 0;
  width: 0;
  height: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.35;

  --vd-surface: #ffffff;
  --vd-surface-2: #f3f4f6;
  --vd-text: #111827;
  --vd-text-2: #4b5563;
  --vd-border: #d1d5db;
  --vd-accent: #2563eb;
  --vd-accent-text: #ffffff;
  --vd-warning-bg: #fef3c7;
  --vd-warning-text: #78350f;
  --vd-danger: #b91c1c;
  --vd-ok: #047857;
  --vd-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}

@media (prefers-color-scheme: dark) {
  :host {
    --vd-surface: #1f2937;
    --vd-surface-2: #111827;
    --vd-text: #f9fafb;
    --vd-text-2: #d1d5db;
    --vd-border: #374151;
    --vd-accent: #60a5fa;
    --vd-accent-text: #0b1220;
    --vd-warning-bg: #422006;
    --vd-warning-text: #fde68a;
    --vd-danger: #f87171;
    --vd-ok: #34d399;
  }
}

* { box-sizing: border-box; }

.vd-trigger {
  position: fixed;
  pointer-events: auto;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  margin: 0;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 9px;
  background: rgba(17, 24, 39, 0.72);
  color: #ffffff;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 120ms ease-out, background-color 120ms ease-out;
}
.vd-trigger:hover,
.vd-trigger[aria-expanded="true"],
.vd-trigger.vd-hot { opacity: 1; background: rgba(17, 24, 39, 0.9); }
.vd-trigger:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; opacity: 1; }
.vd-trigger svg { width: 18px; height: 18px; display: block; }
.vd-trigger[data-state="drm"] { background: rgba(120, 53, 15, 0.85); }
.vd-rec svg circle { fill: #ef4444; }
.vd-rec.vd-recording { opacity: 1; background: #dc2626; border-color: #fecaca; }
.vd-rec.vd-recording svg circle { fill: #ffffff; animation: vd-blink 1.2s ease-in-out infinite; }
@keyframes vd-blink { 50% { opacity: 0.3; } }
.vd-section { margin: 12px 0 2px; font-weight: 600; }
.vd-section:first-of-type { margin-top: 0; }
.vd-recording-now { margin: 0 0 6px; font-weight: 600; color: #dc2626; font-variant-numeric: tabular-nums; }
.vd-trigger .vd-ring {
  position: absolute;
  inset: -1px;
  border-radius: 9px;
  pointer-events: none;
}

.vd-popover {
  position: fixed;
  pointer-events: auto;
  width: 300px;
  max-width: calc(100vw - 16px);
  max-height: min(420px, calc(100vh - 16px));
  overflow-x: hidden;
  overflow-y: auto;
  overflow-wrap: anywhere;
  padding: 12px;
  border: 1px solid var(--vd-border);
  border-radius: 12px;
  background: var(--vd-surface);
  color: var(--vd-text);
  box-shadow: var(--vd-shadow);
}
.vd-popover[hidden] { display: none; }

.vd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 8px;
}
.vd-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vd-close {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--vd-text-2);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}
.vd-close:hover { background: var(--vd-surface-2); }
.vd-close:focus-visible { outline: 2px solid var(--vd-accent); }

.vd-muted { color: var(--vd-text-2); margin: 0 0 8px; }
.vd-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }

.vd-option {
  display: flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--vd-border);
  border-radius: 8px;
  background: var(--vd-surface);
  color: var(--vd-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.vd-option:hover { border-color: var(--vd-accent); }
.vd-option:focus-visible { outline: 2px solid var(--vd-accent); outline-offset: 1px; }
.vd-option[disabled] { opacity: 0.55; cursor: default; }
.vd-option-main { font-weight: 600; }
.vd-option-meta { color: var(--vd-text-2); font-size: 12px; white-space: nowrap; }

.vd-notice {
  margin: 0 0 8px;
  padding: 10px;
  border-radius: 8px;
  background: var(--vd-warning-bg);
  color: var(--vd-warning-text);
}
.vd-notice strong { display: block; margin-bottom: 4px; }

.vd-action {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  margin-top: 4px;
  padding: 6px 12px;
  border: 0;
  border-radius: 8px;
  background: var(--vd-accent);
  color: var(--vd-accent-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.vd-action.vd-secondary {
  background: var(--vd-surface-2);
  color: var(--vd-text);
  border: 1px solid var(--vd-border);
}
.vd-action:focus-visible { outline: 2px solid var(--vd-accent); outline-offset: 2px; }

.vd-job { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--vd-border); }
.vd-job-row { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.vd-progress {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--vd-surface-2);
  overflow: hidden;
}
.vd-progress > span {
  display: block;
  height: 100%;
  width: 0;
  background: var(--vd-accent);
  transition: width 200ms linear;
}
.vd-progress.vd-indeterminate > span { width: 30%; animation: vd-slide 1.2s ease-in-out infinite; }
@keyframes vd-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.vd-ok { color: var(--vd-ok); }
.vd-error { color: var(--vd-danger); }
.vd-path { word-break: break-all; color: var(--vd-text-2); font-size: 12px; }
.vd-note { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--vd-border); }
.vd-note .vd-muted { margin: 0 0 2px; font-size: 12px; }
.vd-foot { margin-top: 10px; text-align: right; }
.vd-link.vd-diag { font-size: 11px; color: var(--vd-text-2); }
.vd-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--vd-accent);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

@media (prefers-reduced-motion: reduce) {
  .vd-rec.vd-recording svg circle { animation: none; }
  .vd-trigger, .vd-progress > span { transition: none; }
  .vd-progress.vd-indeterminate > span { animation: none; width: 100%; opacity: 0.5; }
}
`;

export const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`;

export const REC_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>`;

export const LOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
