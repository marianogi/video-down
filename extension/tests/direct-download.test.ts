/**
 * Race seen on a clean macOS runner (0.1.6 CI): a local file finished so fast that Chrome's
 * "complete" event and the handler's own state check crossed. A late progress update then
 * rewrote the finished download as "downloading 100 %" and the menu never said it was done.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadStage, type DownloadState } from "../src/core/types";

const store = new Map<string, DownloadState>();
vi.mock("../src/core/database/downloads", () => ({
  getDownload: async (id: string) => {
    await Promise.resolve();
    const s = store.get(id);
    return s ? structuredClone(s) : undefined;
  },
  storeDownload: async (s: DownloadState) => {
    await Promise.resolve();
    store.set(s.id, structuredClone(s));
  },
}));
vi.mock("../src/core/storage/settings", () => ({ shouldAskWhereToSave: async () => false }));

type Delta = { id: number; state?: { current: string } };
const listeners: Array<(d: Delta) => void> = [];
let searches = 0;
const item = { id: 7, state: "complete", filename: "/tmp/clip.mp4", bytesReceived: 100, totalBytes: 100 };

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { lastError: undefined },
  downloads: {
    onChanged: { addListener: (f: (d: Delta) => void) => listeners.push(f) },
    download: (_opts: unknown, cb: (id: number) => void) => setTimeout(() => cb(7), 0),
    search: (_q: unknown, cb: (r: unknown[]) => void) => {
      const call = ++searches;
      // Chrome delivers "complete" while the handler's first state check is still in flight,
      // and the event handler's own lookup answers after that check.
      if (call === 1) for (const l of listeners) l({ id: 7, state: { current: "complete" } });
      setTimeout(() => cb([item]), call === 1 ? 0 : 5);
    },
  },
};
globalThis.fetch = (async () => new Response(null, { headers: { "content-type": "video/mp4" } })) as typeof fetch;

describe("direct download completion", () => {
  beforeEach(() => {
    store.clear();
    searches = 0;
    store.set("job", {
      id: "job",
      url: "http://127.0.0.1/clip.mp4",
      metadata: { url: "http://127.0.0.1/clip.mp4", format: "direct", pageUrl: "http://127.0.0.1/" },
      progress: { url: "http://127.0.0.1/clip.mp4", stage: DownloadStage.DOWNLOADING },
      createdAt: 1,
      updatedAt: 1,
    } as unknown as DownloadState);
  });

  it("a late progress event never turns a finished download back into 'downloading'", async () => {
    const { DirectDownloadHandler } = await import("../src/core/downloader/direct/direct-download-handler");
    const pushed: DownloadStage[] = [];
    const handler = new DirectDownloadHandler({ onProgress: (s) => pushed.push(s.progress.stage) });
    await handler.download("http://127.0.0.1/clip.mp4", "clip.mp4", "job");
    await new Promise((r) => setTimeout(r, 50)); // let the late event handler finish
    expect(store.get("job")!.progress.stage).toBe(DownloadStage.COMPLETED);
    expect(pushed.at(-1)).toBe(DownloadStage.COMPLETED);
  });
});
