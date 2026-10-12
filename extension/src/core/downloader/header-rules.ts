/**
 * Declarative Net Request header injection for requests made by the extension.
 *
 * Browsers silently strip `Origin` and `Referer` from `fetch()` calls (they are
 * "forbidden headers"), and requests from the extension carry none at all. Many
 * CDNs refuse playlists, keys or segments without the Origin/Referer of the page
 * that plays the video (typical of players embedded from another site). So while
 * the extension downloads, temporary DNR rules set those headers.
 *
 * Scope of every rule:
 *  - only requests initiated by this extension (initiatorDomains = extension id),
 *  - only XMLHttpRequest/fetch,
 *  - only the hosts the playlists actually point to (one rule per host, any path),
 *  - removed as soon as the fetch or the download ends.
 *
 * Generic for any site: the headers always come from the URL of the frame that
 * plays the video, never from a list of known sites.
 *
 * Forked from Media Bridge (MIT): rules are now per host instead of per folder,
 * keep the port, and cover every host referenced by the segments and keys.
 */

import { logger } from "../utils/logger";

/** Deterministic positive 31-bit rule id for a (job, host) pair. */
function ruleIdFor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return (hash & 0x3fffffff) + 1;
}

/** `||host[:port]/` matches every path on that host (the port matters for non-default ports). */
function hostFilter(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `||${u.host}/`;
  } catch {
    return null;
  }
}

/**
 * Add Origin + Referer rules for every distinct host among `urls`.
 *
 * @param jobId    Download or fetch identifier (used to derive rule ids)
 * @param urls     URLs whose hosts need the headers (playlist, segments, keys…)
 * @param pageUrl  URL of the frame playing the video; its origin is used for the headers
 * @returns The rule ids added (pass them to `removeHeaderRules`)
 */
export async function addHeaderRulesForUrls(jobId: string, urls: string[], pageUrl: string): Promise<number[]> {
  const origin = new URL(pageUrl).origin;
  const filters = [...new Set(urls.map(hostFilter).filter((f): f is string => !!f))];
  if (filters.length === 0) return [];

  const rules: chrome.declarativeNetRequest.Rule[] = filters.map((urlFilter) => ({
    id: ruleIdFor(`${jobId}|${urlFilter}`),
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [
        { header: "Origin", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: origin },
        // What a browser sends on a cross-origin request with the default referrer policy.
        { header: "Referer", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: `${origin}/` },
      ],
    },
    condition: {
      urlFilter,
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
    },
  }));

  const ids = rules.map((r) => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: rules });
  logger.info(`[DNR] Added header rules ${ids.join(",")} for ${filters.join(" ")}`);
  return ids;
}

/** Single-URL form kept for the existing callers. */
export async function addHeaderRules(jobId: string, cdnUrl: string, pageUrl: string): Promise<number[]> {
  return addHeaderRulesForUrls(jobId, [cdnUrl], pageUrl);
}

/**
 * Remove previously added header-injection rules.
 */
export async function removeHeaderRules(ruleIds: number[]): Promise<void> {
  if (ruleIds.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds });
  logger.info(`[DNR] Removed header rules ${ruleIds.join(",")}`);
}

let transientCounter = 0;

/**
 * Run `fn` (a fetch from the service worker) while requests to `url`'s host carry
 * the Origin/Referer of the page that plays the video.
 */
export async function withPageHeaders<T>(url: string, pageUrl: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl) || !/^https?:\/\//i.test(url)) return fn();
  let ruleIds: number[] = [];
  try {
    ruleIds = await addHeaderRules(`fetch_${Date.now()}_${transientCounter++}`, url, pageUrl);
  } catch (err) {
    logger.warn("[DNR] could not add page headers:", err);
  }
  try {
    return await fn();
  } finally {
    if (ruleIds.length) await removeHeaderRules(ruleIds).catch(() => undefined);
  }
}
