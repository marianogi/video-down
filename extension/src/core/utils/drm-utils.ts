/**
 * DRM detection utilities for HLS playlists.
 *
 * Detects DRM-protected content in HLS manifests so the extension can warn the
 * user and refuse the download. Breaking DRM is circumvention of technical
 * protection measures and is out of scope on purpose.
 *
 * Forked from Media Bridge (MIT) and extended with Widevine and SAMPLE-AES.
 */

import { DownloadError } from "./errors";

/** Widevine system ID as used in HLS KEYFORMAT and DASH ContentProtection */
const WIDEVINE_UUID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
/** PlayReady system ID */
const PLAYREADY_UUID = "9a04f079-9840-4286-ab92-e65be0885f95";

const HLS_DRM_MARKERS: Array<{ system: string; pattern: RegExp }> = [
  { system: "FairPlay", pattern: /#EXT-X-(?:SESSION-)?KEY:.*?URI="skd:\/\//i },
  {
    system: "FairPlay",
    pattern: /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.apple\.streamingkeydelivery"/i,
  },
  {
    system: "PlayReady",
    pattern: /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.microsoft\.playready"/i,
  },
  {
    system: "PlayReady",
    pattern: new RegExp(`#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="urn:uuid:${PLAYREADY_UUID}"`, "i"),
  },
  {
    system: "Widevine",
    pattern: new RegExp(`#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="urn:uuid:${WIDEVINE_UUID}"`, "i"),
  },
  // SAMPLE-AES (and its CENC variant) is only ever delivered with a DRM licence server
  { system: "SAMPLE-AES", pattern: /#EXT-X-(?:SESSION-)?KEY:.*?METHOD=SAMPLE-AES/i },
  { system: "Adobe Access", pattern: /#EXT-X-FAXS-CM:/i },
];

/**
 * Return the DRM system declared by an HLS manifest, or null if there is none.
 * Plain AES-128 with a public key URI is NOT DRM and returns null.
 */
export function detectHlsDrm(manifest: string): string | null {
  for (const { system, pattern } of HLS_DRM_MARKERS) {
    if (pattern.test(manifest)) return system;
  }
  return null;
}

/**
 * Check if an HLS manifest contains DRM-protected content.
 */
export function hasDrm(manifest: string): boolean {
  return detectHlsDrm(manifest) !== null;
}

/**
 * Check if an HLS manifest can be decrypted by the extension itself.
 * Only NONE and AES-128 (clear key published in the manifest) are supported.
 */
export function canDecrypt(manifest: string): boolean {
  const encryptionMethodPattern = /#EXT-X-KEY:METHOD=(?!NONE|AES-128\b)[A-Z0-9-]+/i;
  return !encryptionMethodPattern.test(manifest);
}

/**
 * Validate if an HLS manifest can be downloaded.
 *
 * @throws {DownloadError} If the manifest contains DRM-protected content
 * @throws {DownloadError} If the manifest uses unsupported encryption methods
 */
export function canDownloadHLSManifest(manifest: string): void {
  if (hasDrm(manifest)) {
    throw new DownloadError("Cannot download DRM-protected content");
  }
  if (!canDecrypt(manifest)) {
    throw new DownloadError("Cannot decrypt content with unsupported encryption method");
  }
}

/**
 * Return the DRM system declared by a DASH MPD, or null if there is none.
 */
export function detectDashDrm(mpdText: string): string | null {
  // `xmlns:cenc="urn:mpeg:cenc:2013"` alone is NOT protection: match elements/attributes only.
  if (
    !/<(?:\w+:)?ContentProtection\b/i.test(mpdText) &&
    !/cenc:(?:default_KID|pssh)\b/i.test(mpdText)
  ) {
    return null;
  }
  const lower = mpdText.toLowerCase();
  if (lower.includes(WIDEVINE_UUID)) return "Widevine";
  if (lower.includes(PLAYREADY_UUID)) return "PlayReady";
  if (lower.includes("com.apple.fps") || lower.includes("94ce86fb-07ff-4f43-adb8-93d2fa968ca2")) {
    return "FairPlay";
  }
  if (lower.includes("e2719d58-a985-b3c9-781a-b030af78d30e")) return "ClearKey";
  return "CENC";
}
