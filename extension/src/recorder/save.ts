/**
 * Save a recording (or what has been recorded so far) to the Downloads folder.
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
import { shouldAskWhereToSave } from "../core/storage/settings";

const REMUX_LIMIT = 1024 * 1024 * 1024;

export type SaveProgress = (stage: "building" | "converting" | "saving") => void;

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

function baseName(info: RecordingInfo): string {
  return sanitizeFilename(`${info.title || "video"} ${info.label} ${stamp(info.createdAt)}`.trim()).slice(0, 180);
}

async function download(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const saveAs = await shouldAskWhereToSave().catch(() => false);
    const id = await chrome.downloads.download({ url, filename, saveAs });
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
  } finally {
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

/** Returns the names of the files saved. */
export async function saveRecording(info: RecordingInfo, progress: SaveProgress): Promise<string[]> {
  const name = baseName(info);
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
      await download(merged, `${name}.mp4`);
      return [`${name}.mp4`];
    }
    progress("saving");
    await download(video, `${name}.mp4`);
    if (!audio) return [`${name}.mp4`];
    await download(audio, `${name} (audio).m4a`);
    return [`${name}.mp4`, `${name} (audio).m4a`];
  }

  if (info.container === "mp4") {
    const blob = await recordingBlob(info.id, "main", "video/mp4");
    progress("saving");
    await download(blob, `${name}.mp4`);
    return [`${name}.mp4`];
  }

  const ts = await recordingBlob(info.id, "main", "video/mp2t");
  if (ts.size <= REMUX_LIMIT) {
    try {
      progress("converting");
      const mp4 = await remux([{ name: "rec.ts", blob: ts }], ["-bsf:a", "aac_adtstoasc"]);
      progress("saving");
      await download(mp4, `${name}.mp4`);
      return [`${name}.mp4`];
    } catch {
      // A stream ffmpeg cannot put in MP4 as it is: keep the original format.
    }
  }
  progress("saving");
  await download(ts, `${name}.ts`);
  return [`${name}.ts`];
}
