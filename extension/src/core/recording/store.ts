/**
 * Recordings in IndexedDB (its own database, separate from the download engine's chunks).
 *
 * Every part is stored as a Blob: Chrome keeps IndexedDB blobs on disk, so a recording of
 * hours never has to fit in memory, and the saved file is a Blob made of those blobs, which
 * Chrome streams from disk too.
 */

import type { PartRef, TrackKind } from "./local-playlist";

export type RecordingMode = "copy" | "capture";
export type RecordingState = "recording" | "stopped" | "ended" | "error";

export interface RecordingInfo {
  id: string;
  mode: RecordingMode;
  title: string;
  /** Quality or profile chosen, for the UI and the file name */
  label: string;
  /** "ts" for MPEG-TS segments, "mp4" for fragmented MP4 */
  container: "ts" | "mp4";
  /** Tracks recorded: ["main"], or ["video", "audio"] when they come separately */
  tracks: TrackKind[];
  pageUrl: string;
  createdAt: number;
  updatedAt: number;
  state: RecordingState;
  bytes: number;
  /** Seconds recorded (of the reference track) */
  duration: number;
  /** HLS CODECS of what was recorded, when the player must be told (capture) */
  codecs?: string;
  /** The page's audio never started: the capture records the picture only */
  noAudio?: boolean;
  savedAt?: number;
  error?: string;
}

export interface StoredPart extends PartRef {
  recordingId: string;
  track: TrackKind;
  size: number;
  blob: Blob;
}

const DB_NAME = "video-down-recordings";
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("recordings", { keyPath: "id" });
      db.createObjectStore("parts", { keyPath: ["recordingId", "track", "seq"] });
      db.createObjectStore("inits", { keyPath: ["recordingId", "track", "initId"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("cannot open the recordings database"));
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

async function store(name: "recordings" | "parts" | "inits", mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function putRecording(info: RecordingInfo): Promise<void> {
  await done((await store("recordings", "readwrite")).put({ ...info, updatedAt: Date.now() }));
}

export async function getRecording(id: string): Promise<RecordingInfo | undefined> {
  return (await done((await store("recordings", "readonly")).get(id))) as RecordingInfo | undefined;
}

export async function listRecordings(): Promise<RecordingInfo[]> {
  const all = (await done((await store("recordings", "readonly")).getAll())) as RecordingInfo[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putPart(part: StoredPart): Promise<void> {
  await done((await store("parts", "readwrite")).put(part));
}

export async function putInit(recordingId: string, track: TrackKind, initId: number, blob: Blob): Promise<void> {
  await done((await store("inits", "readwrite")).put({ recordingId, track, initId, blob }));
}

function range(recordingId: string, track: TrackKind): IDBKeyRange {
  return IDBKeyRange.bound([recordingId, track, 0], [recordingId, track, Number.MAX_SAFE_INTEGER]);
}

/** Parts of a track in order, without loading their data (blobs stay on disk until read). */
export async function listParts(recordingId: string, track: TrackKind): Promise<StoredPart[]> {
  return (await done((await store("parts", "readonly")).getAll(range(recordingId, track)))) as StoredPart[];
}

/** Parts recorded after `fromSeq` (the time-shift player only asks for what is new). */
export async function listPartsFrom(recordingId: string, track: TrackKind, fromSeq: number): Promise<StoredPart[]> {
  const r = IDBKeyRange.bound([recordingId, track, fromSeq], [recordingId, track, Number.MAX_SAFE_INTEGER]);
  return (await done((await store("parts", "readonly")).getAll(r))) as StoredPart[];
}

export async function getPart(recordingId: string, track: TrackKind, seq: number): Promise<StoredPart | undefined> {
  return (await done((await store("parts", "readonly")).get([recordingId, track, seq]))) as StoredPart | undefined;
}

export async function getInit(recordingId: string, track: TrackKind, initId: number): Promise<Blob | undefined> {
  const row = (await done((await store("inits", "readonly")).get([recordingId, track, initId]))) as
    | { blob: Blob }
    | undefined;
  return row?.blob;
}

export async function deleteRecording(recordingId: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(["recordings", "parts", "inits"], "readwrite");
  tx.objectStore("recordings").delete(recordingId);
  for (const track of ["main", "video", "audio"] as TrackKind[]) {
    tx.objectStore("parts").delete(range(recordingId, track));
    tx.objectStore("inits").delete(IDBKeyRange.bound([recordingId, track, 0], [recordingId, track, Number.MAX_SAFE_INTEGER]));
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("could not delete the recording"));
  });
}

/**
 * The recording as one file: the init segment where the container needs it, then every part
 * in order. A Blob of stored blobs: Chrome reads it from disk when it is saved.
 */
export async function recordingBlob(recordingId: string, track: TrackKind, type: string): Promise<Blob> {
  const parts = await listParts(recordingId, track);
  const pieces: Blob[] = [];
  let currentInit: number | undefined;
  for (const p of parts) {
    if (p.initId !== undefined && p.initId !== currentInit) {
      const init = await getInit(recordingId, track, p.initId);
      if (init) pieces.push(init);
      currentInit = p.initId;
    }
    pieces.push(p.blob);
  }
  return new Blob(pieces, { type });
}
