/**
 * Thin wrapper over chrome.i18n with a fallback for tests and for the rare
 * case where the extension context has been invalidated mid-session.
 */

type Catalog = Record<string, { message: string }>;
let bundled: { en: Catalog; es: Catalog } | null = null;

/**
 * The extension's own pages register a copy of the catalogs: Chrome has been seen to open one
 * (the recorder, as a background tab) whose chrome.i18n answered every key with "", and it showed
 * "recStateRecording" instead of "Recording". Not used by the scripts injected into websites.
 */
export function useBundledMessages(catalogs: { en: Catalog; es: Catalog }): void {
  bundled = catalogs;
}

function fromBundle(key: string, substitutions?: string | string[]): string {
  if (!bundled) return "";
  let lang = "en";
  try {
    lang = chrome.i18n.getUILanguage();
  } catch {
    lang = navigator.language || "en";
  }
  // The same choice Chrome makes with these two catalogs: Spanish for any "es-*", else English.
  const message = (lang.toLowerCase().startsWith("es") ? bundled.es : bundled.en)[key]?.message ?? bundled.en[key]?.message;
  if (!message) return "";
  const list = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  return message.replace(/\$(\$|[1-9])/g, (_, n: string) => (n === "$" ? "$" : (list[Number(n) - 1] ?? "")));
}

export function t(key: string, substitutions?: string | string[]): string {
  try {
    const value = chrome.i18n.getMessage(key, substitutions);
    if (value) return value;
  } catch {
    // context invalidated (extension reloaded) — fall through
  }
  return fromBundle(key, substitutions) || key;
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
