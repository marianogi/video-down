/**
 * Split a growing fragmented-MP4 byte stream (MediaRecorder output) into its initialisation
 * segment (ftyp + moov) and its fragments (moof + mdat), each with its start time and duration.
 *
 * MediaRecorder hands over bytes in arbitrary slices; boxes are cut here at their real
 * boundaries so every fragment can be stored, played (as an fMP4 HLS segment) and concatenated
 * on save into a valid MP4. Only top-level boxes and the few boxes that carry timing are read.
 * Pure: unit-tested.
 */

export interface TrackInfo {
  id: number;
  kind: "video" | "audio" | "other";
  timescale: number;
  /** trex default sample duration, used when a fragment does not say */
  defaultDuration: number;
}

/** Bytes owned by a plain ArrayBuffer (what Blob accepts). */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface Mp4Fragment {
  bytes: Bytes;
  /** Seconds, of the reference track (video when there is one) */
  start: number;
  duration: number;
}

const decoder = new TextDecoder("latin1");

function typeAt(b: Uint8Array, off: number): string {
  return decoder.decode(b.subarray(off + 4, off + 8));
}

function u32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) >>> 0) + (b[off + 1]! << 16) + (b[off + 2]! << 8) + b[off + 3]!;
}

function u64(b: Uint8Array, off: number): number {
  return u32(b, off) * 2 ** 32 + u32(b, off + 4);
}

/** Size of the box at `off`, or -1 when its header is not complete yet. 0 = "to the end". */
function boxSize(b: Uint8Array, off: number): { size: number; header: number } | null {
  if (off + 8 > b.length) return null;
  const size = u32(b, off);
  if (size === 1) {
    if (off + 16 > b.length) return null;
    return { size: u64(b, off + 8), header: 16 };
  }
  return { size, header: 8 };
}

/** Children of a container box: [type, start, end] with start = first byte of the child. */
function children(b: Uint8Array, start: number, end: number): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let off = start;
  while (off + 8 <= end) {
    const s = boxSize(b, off);
    if (!s || s.size < 8 || off + s.size > end) break;
    out.push([typeAt(b, off), off, off + s.size]);
    off += s.size;
  }
  return out;
}

function child(b: Uint8Array, start: number, end: number, type: string): [number, number] | null {
  const c = children(b, start, end).find(([t]) => t === type);
  return c ? [c[1], c[2]] : null;
}

/** Tracks declared in a moov box. */
export function parseMoov(b: Uint8Array): Map<number, TrackInfo> {
  const tracks = new Map<number, TrackInfo>();
  const top = children(b, 0, b.length).find(([t]) => t === "moov");
  if (!top) return tracks;
  const [, mStart, mEnd] = top;
  const trexDefaults = new Map<number, number>();
  const mvex = child(b, mStart + 8, mEnd, "mvex");
  if (mvex) {
    for (const [t, s] of children(b, mvex[0] + 8, mvex[1])) {
      if (t === "trex") trexDefaults.set(u32(b, s + 12), u32(b, s + 20));
    }
  }
  for (const [t, s, e] of children(b, mStart + 8, mEnd)) {
    if (t !== "trak") continue;
    const tkhd = child(b, s + 8, e, "tkhd");
    const mdia = child(b, s + 8, e, "mdia");
    if (!tkhd || !mdia) continue;
    const version = b[tkhd[0] + 8]!;
    const id = u32(b, tkhd[0] + (version === 1 ? 28 : 20));
    const mdhd = child(b, mdia[0] + 8, mdia[1], "mdhd");
    const hdlr = child(b, mdia[0] + 8, mdia[1], "hdlr");
    if (!mdhd) continue;
    const mdhdVersion = b[mdhd[0] + 8]!;
    const timescale = u32(b, mdhd[0] + (mdhdVersion === 1 ? 28 : 20));
    const handler = hdlr ? decoder.decode(b.subarray(hdlr[0] + 16, hdlr[0] + 20)) : "";
    const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";
    tracks.set(id, { id, kind, timescale, defaultDuration: trexDefaults.get(id) ?? 0 });
  }
  return tracks;
}

/** Start and duration (in timescale units) of each track fragment in a moof box. */
export function parseMoof(b: Uint8Array, tracks: Map<number, TrackInfo>): Map<number, { base: number; duration: number }> {
  const out = new Map<number, { base: number; duration: number }>();
  for (const [t, s, e] of children(b, 8, b.length)) {
    if (t !== "traf") continue;
    let trackId = 0;
    let defaultDuration = 0;
    let base = 0;
    let duration = 0;
    for (const [ct, cs] of children(b, s + 8, e)) {
      if (ct === "tfhd") {
        const flags = u32(b, cs + 8) & 0xffffff;
        trackId = u32(b, cs + 12);
        let p = cs + 16;
        if (flags & 0x01) p += 8; // base data offset
        if (flags & 0x02) p += 4; // sample description index
        if (flags & 0x08) defaultDuration = u32(b, p);
        if (!defaultDuration) defaultDuration = tracks.get(trackId)?.defaultDuration ?? 0;
      } else if (ct === "tfdt") {
        base = b[cs + 8] === 1 ? u64(b, cs + 12) : u32(b, cs + 12);
      } else if (ct === "trun") {
        const flags = u32(b, cs + 8) & 0xffffff;
        const count = u32(b, cs + 12);
        let p = cs + 16;
        if (flags & 0x01) p += 4; // data offset
        if (flags & 0x04) p += 4; // first sample flags
        const perSample =
          (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
        if (flags & 0x100) {
          for (let i = 0; i < count; i++) duration += u32(b, p + i * perSample);
        } else {
          duration += count * defaultDuration;
        }
      }
    }
    if (trackId) out.set(trackId, { base, duration });
  }
  return out;
}

/** VP9 level written when MediaRecorder leaves it at 0: 4.0 (up to 1080p). Only a capability hint. */
const VP9_DEFAULT_LEVEL = 40;

/**
 * MediaRecorder writes VP9 in MP4 with level 0 in its vpcC box ("vp09.00.00.08"), a codec
 * string Chrome's own player refuses. Give it a valid level, in place; nothing else changes.
 */
export function fixVp9Level(init: Bytes): Bytes {
  for (let i = 4; i + 10 <= init.length; i++) {
    // "vpcC" preceded by its 32-bit size
    if (init[i] !== 0x76 || init[i + 1] !== 0x70 || init[i + 2] !== 0x63 || init[i + 3] !== 0x43) continue;
    const start = i - 4;
    const size = u32(init, start);
    if (size < 14 || start + size > init.length) continue;
    const levelAt = start + 13; // header 8, version and flags 4, profile 1
    if (init[levelAt] === 0) init[levelAt] = VP9_DEFAULT_LEVEL;
  }
  return init;
}

export class Mp4FragmentSplitter {
  private pending: Bytes = new Uint8Array(0);
  private initParts: Bytes[] = [];
  private initDone = false;
  private tracks = new Map<number, TrackInfo>();
  private fragmentParts: Bytes[] = [];
  private lastDuration = 0;

  /** Feed bytes; returns the init segment once (when the first fragment starts) and complete fragments. */
  push(chunk: Uint8Array): { init?: Bytes; fragments: Mp4Fragment[] } {
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending);
    merged.set(chunk, this.pending.length);
    let off = 0;
    let init: Bytes | undefined;
    const fragments: Mp4Fragment[] = [];
    while (true) {
      const s = boxSize(merged, off);
      if (!s || s.size === 0 || off + s.size > merged.length) break;
      if (s.size < 8) throw new Error("invalid MP4 box");
      const box = merged.slice(off, off + s.size);
      const type = typeAt(box, 0);
      if (!this.initDone && type !== "moof") {
        this.initParts.push(box);
      } else {
        if (!this.initDone) {
          this.initDone = true;
          init = concat(this.initParts);
          this.tracks = parseMoov(init);
        }
        if (type === "moof" && this.fragmentParts.length > 0) fragments.push(this.finishFragment());
        this.fragmentParts.push(box);
        if (type === "mdat") fragments.push(this.finishFragment());
      }
      off += s.size;
    }
    this.pending = merged.slice(off);
    return { ...(init ? { init } : {}), fragments };
  }

  /** Whatever is left when the recording stops (a fragment without its mdat is dropped). */
  flush(): Mp4Fragment[] {
    const hasMdat = this.fragmentParts.some((p) => typeAt(p, 0) === "mdat");
    const out = hasMdat ? [this.finishFragment()] : [];
    this.fragmentParts = [];
    this.pending = new Uint8Array(0);
    return out;
  }

  get trackInfo(): Map<number, TrackInfo> {
    return this.tracks;
  }

  private finishFragment(): Mp4Fragment {
    const bytes = concat(this.fragmentParts);
    this.fragmentParts = [];
    const moof = bytes.subarray(0, u32(bytes, 0));
    const times = parseMoof(moof, this.tracks);
    const ref =
      [...this.tracks.values()].find((t) => t.kind === "video" && times.has(t.id)) ??
      [...this.tracks.values()].find((t) => times.has(t.id));
    const timing = ref ? times.get(ref.id) : undefined;
    const scale = ref?.timescale || 1;
    const duration = timing && timing.duration > 0 ? timing.duration / scale : this.lastDuration;
    this.lastDuration = duration;
    return { bytes, start: timing ? timing.base / scale : 0, duration };
  }
}

function concat(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
