import type { MaskRect } from "./mask-registry.js";

// Pixel redaction (SPEC-mobile §6.6): masked rects are blacked out on the
// JPEG BEFORE it enters the stream — masked pixels never leave the device.
// The codec is injected: jpeg-js when the optional peer is present
// (rn-defaults), a fake in tests. Everything here fails closed: any parse or
// codec error returns null and the caller drops the frame.

/** RGBA bitmap, jpeg-js's shape. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface JpegCodec {
  decode(bytes: Uint8Array): DecodedImage;
  encode(image: DecodedImage, quality: number): { data: Uint8Array };
}

const DATA_URI_PREFIX = /^data:image\/jpe?g;base64,/;

/** Re-encode quality: the frame was already q0.35 at capture. */
const ENCODE_QUALITY = 60;

/**
 * Black out `rects` (window dp — the same space as the capture, SPEC-mobile
 * §6.4) on a JPEG data-URI. Rects round OUTWARD to whole pixels and clamp to
 * the image. Returns the redacted data-URI, or null on any failure.
 */
export function redactDataUri(
  codec: JpegCodec,
  dataUri: string,
  rects: MaskRect[],
): string | null {
  try {
    const match = DATA_URI_PREFIX.exec(dataUri);
    if (!match) return null;
    const image = codec.decode(base64ToBytes(dataUri.slice(match[0].length)));
    for (const rect of rects) {
      const x0 = Math.max(0, Math.floor(rect.x));
      const y0 = Math.max(0, Math.floor(rect.y));
      const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
      const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * image.width + x) * 4;
          image.data[i] = 0;
          image.data[i + 1] = 0;
          image.data[i + 2] = 0;
          image.data[i + 3] = 255;
        }
      }
    }
    const encoded = codec.encode(image, ENCODE_QUALITY);
    return `data:image/jpeg;base64,${bytesToBase64(encoded.data)}`;
  } catch {
    return null;
  }
}

// Base64 for raw bytes, dependency-free: neither Buffer nor atob/btoa is
// guaranteed on every RN runtime (src/encoding.ts is string-oriented).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REVERSE: number[] = [];
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET.charCodeAt(i)] = i;

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = REVERSE[clean.charCodeAt(i)];
    if (value === undefined) throw new Error("bad base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2]!;
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? "=" : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? "=" : ALPHABET[b2 & 0x3f]!;
  }
  return out;
}
