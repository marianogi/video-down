/**
 * Service-worker side of "capture the player": turns the base64 slices sent by the page into
 * the recording's init segment and timed fMP4 fragments, stored as they complete.
 */

import { fixVp9Level, Mp4FragmentSplitter, type Bytes } from "./mp4-fragments";
import { putInit, putPart, type StoredPart } from "./store";

/** Base64 of one MediaRecorder slice: a few MB at most. Anything bigger is refused. */
const MAX_SLICE_CHARS = 64 * 1024 * 1024;

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class CaptureReceiver {
  private readonly splitter = new Mp4FragmentSplitter();
  private seq = 0;
  private hasInit = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly recordingId: string,
    private readonly onPart: (part: StoredPart) => void,
  ) {}

  /** Feed one slice (in order). Rejects on bytes that are not a fragmented MP4. */
  push(base64: string): Promise<void> {
    if (typeof base64 !== "string" || base64.length > MAX_SLICE_CHARS) return Promise.reject(new Error("invalid slice"));
    const bytes = fromBase64(base64);
    this.queue = this.queue.then(async () => {
      const out = this.splitter.push(bytes);
      if (out.init) {
        await putInit(this.recordingId, "main", 0, new Blob([fixVp9Level(out.init)]));
        this.hasInit = true;
      }
      for (const f of out.fragments) await this.store(f.bytes, f.duration);
    });
    return this.queue;
  }

  /** The recording stopped: store whatever complete fragment is left. */
  finish(): Promise<void> {
    this.queue = this.queue.then(async () => {
      for (const f of this.splitter.flush()) await this.store(f.bytes, f.duration);
    });
    return this.queue;
  }

  private async store(bytes: Bytes, duration: number): Promise<void> {
    if (!this.hasInit) return;
    const part: StoredPart = {
      recordingId: this.recordingId,
      track: "main",
      seq: this.seq++,
      duration,
      initId: 0,
      size: bytes.byteLength,
      blob: new Blob([bytes]),
    };
    await putPart(part);
    this.onPart(part);
  }
}
