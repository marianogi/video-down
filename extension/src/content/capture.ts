/**
 * "Capture the player": records what a <video> shows, with captureStream() + MediaRecorder,
 * and streams the bytes to the service worker, which stores them as the recording grows.
 *
 * Works for any player the page can play without DRM (a DRM video gives black frames, and the
 * extension never offers it). Re-encodes in real time with the profile the user chose.
 * Runtime messages carry JSON only, so the bytes travel base64-encoded, in order.
 */

import { CAPTURE_PROFILES, pickMimeType, profileById, videoBitrate } from "../core/recording/profiles";

export interface CaptureHandle {
  stop(): void;
}

export type CaptureError = "unsupported" | "protected" | "no-video";

const SLICE_MS = 1000;
const KEYFRAME_MS = 2000;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Profiles this browser can record, with the codec each one would use. */
export function availableProfiles(): Array<{ id: string; mimeType: string }> {
  if (typeof MediaRecorder === "undefined") return [];
  return CAPTURE_PROFILES.flatMap((p) => {
    const mimeType = pickMimeType(p, (t) => MediaRecorder.isTypeSupported(t));
    return mimeType ? [{ id: p.id, mimeType }] : [];
  });
}

export function startCapture(
  video: HTMLVideoElement,
  recordingId: string,
  profileId: string,
  onEnd: (reason: string) => void,
): CaptureHandle | { error: CaptureError } {
  const profile = profileById(profileId);
  const mimeType = profile && typeof MediaRecorder !== "undefined"
    ? pickMimeType(profile, (t) => MediaRecorder.isTypeSupported(t))
    : null;
  if (!profile || !mimeType) return { error: "unsupported" };

  let stream: MediaStream;
  try {
    // Throws when the video comes from another origin without CORS (its pixels are not readable).
    stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  } catch {
    return { error: "protected" };
  }
  if (stream.getVideoTracks().length === 0 && video.readyState === 0) return { error: "no-video" };

  const options = {
    mimeType,
    videoBitsPerSecond: videoBitrate(profile, video.videoWidth, video.videoHeight),
    audioBitsPerSecond: profile.audioBitsPerSecond,
    // A keyframe every 2 s: each fragment starts with one, so the recording can be played from
    // any point while it grows (Chrome 117+; ignored elsewhere).
    videoKeyFrameIntervalDuration: KEYFRAME_MS,
  } as MediaRecorderOptions;

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch {
    return { error: "unsupported" };
  }

  const port = chrome.runtime.connect({ name: `vd-capture:${recordingId}` });
  let ended = false;
  // Blob.arrayBuffer() promises may settle out of order: chain them so bytes stay in order.
  let queue: Promise<void> = Promise.resolve();
  const post = (message: unknown) => {
    try {
      port.postMessage(message);
    } catch {
      finish("disconnected");
    }
  };

  const finish = (reason: string) => {
    if (ended) return;
    ended = true;
    for (const t of stream.getTracks()) t.removeEventListener("ended", onTrackEnded);
    video.removeEventListener("emptied", onEmptied);
    if (recorder.state !== "inactive") {
      recorder.onstop = () => {
        void queue.then(() => {
          post({ type: "end", reason });
          setTimeout(() => port.disconnect(), 200);
        });
      };
      recorder.stop();
    } else {
      void queue.then(() => post({ type: "end", reason }));
    }
    onEnd(reason);
  };
  const onTrackEnded = () => finish("source-ended");
  // The player loaded something else into the element (another video, or it gave up).
  const onEmptied = () => finish("source-changed");

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    const blob = event.data;
    queue = queue.then(async () => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      post({ type: "chunk", data: toBase64(bytes) });
    });
  };
  recorder.onerror = () => finish("recorder-error");
  port.onDisconnect.addListener(() => {
    if (!ended) finish("stopped");
  });
  // Stopped from the recorder page or the toolbar popup.
  port.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === "stop") finish("stopped");
  });
  for (const t of stream.getTracks()) t.addEventListener("ended", onTrackEnded);
  video.addEventListener("emptied", onEmptied);

  post({ type: "info", mimeType, width: video.videoWidth, height: video.videoHeight });
  recorder.start(SLICE_MS);
  return { stop: () => finish("stopped") };
}
