/**
 * Propose a download's name in the step Chrome uses to decide names, which comes before its "Save
 * as" dialog. The `filename` given to chrome.downloads.download is not enough: as soon as another
 * extension listens to this event (Internet Download Manager's does, without ever naming anything),
 * Chrome ignores that parameter and the dialog proposes "download" with no extension, or a blob's id.
 *
 * Measured with an extension whose listener is empty: this proposal wins only when video-down is the
 * most recently installed or updated of the extensions that listen. Reloading video-down, as each of
 * its updates does, makes it so; an update of the other extension loses it until the next reload.
 *
 * Only listens while a download of ours is pending: this event holds every download in Chrome. The
 * listener stays until the download is settled: removing it before Chrome has read the proposal makes
 * Chrome discard the proposal.
 */

const pending = new Map<string, string>();

function onDetermining(
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.FilenameSuggestion) => void,
): void {
  const filename = pending.get(item.url) ?? pending.get(item.finalUrl);
  // Any other download: nothing is said, and Chrome names it as usual.
  if (filename !== undefined) suggest({ filename, conflictAction: "uniquify" });
}

/**
 * Call it before starting the download of `url`, and the function it returns once that download has
 * finished or failed.
 */
export function suggestDownloadName(url: string, filename: string): () => void {
  pending.set(url, filename);
  chrome.downloads.onDeterminingFilename.addListener(onDetermining);
  return () => {
    pending.delete(url);
    if (pending.size === 0) chrome.downloads.onDeterminingFilename.removeListener(onDetermining);
  };
}
