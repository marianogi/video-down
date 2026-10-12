/**
 * Chrome native messaging framing: each message is a 32-bit unsigned length
 * in native byte order (little-endian on every platform we ship) followed by
 * that many bytes of UTF-8 JSON.
 */

/** Messages from the extension are tiny; anything bigger is garbage or abuse. */
export const MAX_INCOMING_BYTES = 1024 * 1024;
/** Chrome rejects host → extension messages above 1 MB. */
export const MAX_OUTGOING_BYTES = 1024 * 1024;

export function encodeMessage(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.length > MAX_OUTGOING_BYTES) {
    throw new Error(`outgoing message too large: ${body.length} bytes`);
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

/**
 * Incremental decoder: feed it raw stdin chunks, get complete messages back.
 * Throws on oversized frames so a broken peer cannot exhaust memory.
 */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, true);
      if (length > MAX_INCOMING_BYTES) {
        throw new Error(`incoming message too large: ${length} bytes`);
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      messages.push(JSON.parse(new TextDecoder().decode(body)));
    }
    return messages;
  }
}
