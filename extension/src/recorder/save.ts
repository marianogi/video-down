/**
 * Save a recording (or what has been recorded so far) where the person chooses: Chrome's "Save as"
 * dialog always opens, with the name given on the page (folder and name can still be changed there).
 * Until then the recording only lives in video-down's storage inside Chrome (IndexedDB, on disk).
 *
 *  - Fragmented MP4 (player capture, or a live stream that sends fMP4): saved as it is, any size;
 *    the file is a Blob of the stored blobs, which Chrome reads from disk.
 *  - MPEG-TS (most live HLS): converted to MP4 with ffmpeg.wasm, copying the streams, up to
 *    1 GB (ffmpeg.wasm keeps its output in memory); above that it is saved as .ts, which VLC and
 *    most players open.
 *  - Video and audio recorded separately: merged into one MP4 up to 1 GB; above that, two files.
 */

import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { recordingBlob, type RecordingInfo } from "../core/recording/store";
import { sanitizeFilename } from "../core/utils/file-utils";

const REMUX_LIMIT = 1024 * 1024 * 1024;

export type SaveProgress = (stage: "building" | "converting" | "saving") => void;

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** The name the page proposes: title, quality and when it started. */
export function defaultName(info: RecordingInfo): string {
  return sanitizeFilename(`${info.title || "video"} ${info.label} ${stamp(info.createdAt)}`.trim()).slice(0, 180);
}

/** A saved file: Chrome's download id and the full path it was written to. */
export interface SavedFile {
  id: number;
  path: string;
}

async function download(blob: Blob, filename: string): Promise<SavedFile> {
  const url = URL.createObjectURL(blob);
  // With saveAs, Chrome's dialog proposed the blob's id (a token) instead of `filename`. Naming the
  // download when Chrome determines its name, which comes before the dialog, makes it propose ours.
  // Any other download: nothing is said, and Chrome names it as usual.
  const onDetermining = (item: chrome.downloads.DownloadItem, suggest: (s?: chrome.downloads.FilenameSuggestion) => void) => {
    if (item.url === url || item.finalUrl === url) suggest({ filename, conflictAction: "uniquify" });
  };
  chrome.downloads.onDeterminingFilename.addListener(onDetermining);
  try {
    // A recording is saved on purpose, one at a time: always let the person choose where and how.
    const id = await chrome.downloads.download({ url, filename, saveAs: true });
    // The blob URL must live until Chrome has written the file.
    await new Promise<void>((resolve, reject) => {
      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === "complete") done();
        else if (delta.state.current === "interrupted") done(new Error("download interrupted"));
      };
      const done = (err?: Error) => {
        chrome.downloads.onChanged.removeListener(onChanged);
        if (err) reject(err);
        else resolve();
      };
      chrome.downloads.onChanged.addListener(onChanged);
      void chrome.downloads.search({ id }).then(([item]) => {
        if (item?.state === "complete") done();
        else if (item?.state === "interrupted") done(new Error(item.error || "download interrupted"));
      });
    });
    const [item] = await chrome.downloads.search({ id });
    return { id, path: item?.filename || filename };
  } finally {
    chrome.downloads.onDeterminingFilename.removeListener(onDetermining);
    URL.revokeObjectURL(url);
  }
}

let ffmpeg: Promise<FFmpeg> | null = null;
function getFFmpeg(): Promise<FFmpeg> {
  ffmpeg ??= (async () => {
    const instance = new FFmpeg();
    await instance.load({
      coreURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.wasm"),
    });
    return instance;
  })().catch((err) => {
    ffmpeg = null;
    throw err;
  });
  return ffmpeg;
}

/** Copy streams into an MP4. Inputs are mounted (read from the blobs), not copied into memory. */
async function remux(inputs: Array<{ name: string; blob: Blob }>, extraArgs: string[]): Promise<Blob> {
  const ff = await getFFmpeg();
  const dir = `/in${Date.now()}`;
  await ff.createDir(dir);
  await ff.mount(FFFSType.WORKERFS, { blobs: inputs.map((i) => ({ name: i.name, data: i.blob })) }, dir);
  const out = `/out${Date.now()}.mp4`;
  try {
    const args = [...inputs.flatMap((i) => ["-i", `${dir}/${i.name}`]), "-c", "copy", ...extraArgs, "-movflags", "+faststart", out];
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
    const data = (await ff.readFile(out)) as Uint8Array;
    return new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
  } finally {
    await ff.deleteFile(out).catch(() => undefined);
    await ff.unmount(dir).catch(() => undefined);
    await ff.deleteDir(dir).catch(() => undefined);
  }
}

/** Returns the files saved. `chosen` is the name given on the page (without extension). */
export async function saveRecording(info: RecordingInfo, progress: SaveProgress, chosen?: string): Promise<SavedFile[]> {
  const name = sanitizeFilename(chosen?.trim() ?? "").slice(0, 180) || defaultName(info);
  progress("building");

  if (info.tracks.includes("video")) {
    const video = await recordingBlob(info.id, "video", "video/mp4");
    const audio = info.tracks.includes("audio") ? await recordingBlob(info.id, "audio", "audio/mp4") : null;
    if (audio && video.size + audio.size <= REMUX_LIMIT) {
      progress("converting");
      const merged = await remux(
        [
          { name: "video.mp4", blob: video },
          { name: "audio.mp4", blob: audio },
        ],
        ["-map", "0:v:0", "-map", "1:a:0"],
      );
      progress("saving");
      return [await download(merged, `${name}.mp4`)];
    }
    progress("saving");
    const first = await download(video, `${name}.mp4`);
    if (!audio) return [first];
    return [first, await download(audio, `${name} (audio).m4a`)];
  }

  if (info.container === "mp4") {
    const blob = await recordingBlob(info.id, "main", "video/mp4");
    progress("saving");
    return [await download(blob, `${name}.mp4`)];
  }

  const ts = await recordingBlob(info.id, "main", "video/mp2t");
  if (ts.size <= REMUX_LIMIT) {
    try {
      progress("converting");
      const mp4 = await remux([{ name: "rec.ts", blob: ts }], ["-bsf:a", "aac_adtstoasc"]);
      progress("saving");
      return [await download(mp4, `${name}.mp4`)];
    } catch (err) {
      // The person cancelled the dialog: nothing more to do.
      if (err instanceof Error && /USER_CANCELED/i.test(err.message)) throw err;
      // A stream ffmpeg cannot put in MP4 as it is: keep the original format.
    }
  }
  progress("saving");
  return [await download(ts, `${name}.ts`)];
}
