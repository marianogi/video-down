/**
 * Blob URL save + revocation utilities
 */

import { MessageType } from "../../shared/messages";
import { getDownload, storeDownload } from "../database/downloads";
import { logger } from "./logger";
import { shouldAskWhereToSave } from "../storage/settings";

/**
 * Revoke a blob URL via the offscreen document.
 * Swallows errors to avoid masking caller errors.
 */
export function revokeBlobUrl(blobUrl: string): void {
  chrome.runtime.sendMessage(
    { type: MessageType.REVOKE_BLOB_URL, payload: { blobUrl } },
    () => {
      if (chrome.runtime.lastError) {
        // intentionally swallowed
      }
    },
  );
}

/**
 * Save a blob URL to a file via the Chrome downloads API.
 * Stores the chromeDownloadId in the download state for reliable cancellation.
 */
/** Maximum time to wait for the save to finish (includes a possible "Save as" dialog) */
const MAX_POLL_DURATION_MS = 30 * 60 * 1000;

export async function saveBlobUrlToFile(
  blobUrl: string,
  filename: string,
  stateId: string,
): Promise<string> {
  const saveAs = await shouldAskWhereToSave();
  try {
    return await new Promise<string>((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename,
          saveAs,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            logger.error(
              `Chrome downloads API error: ${chrome.runtime.lastError.message}`,
            );
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (downloadId === undefined) {
            reject(new Error("Chrome downloads API returned no download ID"));
            return;
          }

          let settled = false;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const settle = (state: "complete" | "interrupted", error?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            chrome.downloads.onChanged.removeListener(onChange);
            revokeBlobUrl(blobUrl);
            if (state === "interrupted") {
              reject(new Error(error || "Download interrupted"));
              return;
            }
            chrome.downloads.search({ id: downloadId }, (results) => {
              resolve(results?.[0]?.filename || filename);
            });
          };

          // Listen first: a blob is saved almost instantly, and Media Bridge attached this
          // listener only after two database round-trips, so "complete" could be missed and
          // the download hung until the timeout.
          function onChange(delta: chrome.downloads.DownloadDelta) {
            if (delta.id !== downloadId || !delta.state) return;
            if (delta.state.current === "complete") settle("complete");
            else if (delta.state.current === "interrupted") {
              settle("interrupted", (delta as { error?: { current?: string } }).error?.current);
            }
          }
          chrome.downloads.onChanged.addListener(onChange);

          // Generous: with "Ask where to save" the user may take a while in the dialog.
          timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            chrome.downloads.onChanged.removeListener(onChange);
            reject(new Error("Download timed out"));
          }, MAX_POLL_DURATION_MS);

          void (async () => {
            // Store chromeDownloadId in download state for reliable cancellation
            const currentState = await getDownload(stateId);
            if (currentState) {
              currentState.chromeDownloadId = downloadId;
              await storeDownload(currentState);
            }
            // In case it finished before the listener above was attached.
            chrome.downloads.search({ id: downloadId }, (results) => {
              const item = results?.[0];
              if (item?.state === "complete") settle("complete");
              else if (item?.state === "interrupted") settle("interrupted", item.error);
            });
          })();
        },
      );
    });
  } catch (error) {
    revokeBlobUrl(blobUrl);
    throw error;
  }
}
