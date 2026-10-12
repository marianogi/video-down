/**
 * Thin wrapper over chrome.i18n with a fallback for tests and for the rare
 * case where the extension context has been invalidated mid-session.
 */

export function t(key: string, substitutions?: string | string[]): string {
  try {
    const value = chrome.i18n.getMessage(key, substitutions);
    if (value) return value;
  } catch {
    // context invalidated (extension reloaded) — fall through
  }
  return key;
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h} h ${m % 60} min`;
  if (m > 0) return `${m} min ${s % 60} s`;
  return `${s} s`;
}
