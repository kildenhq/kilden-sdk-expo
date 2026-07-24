import { describe, expect, it } from "vitest";

import { MaskRegistry } from "../src/replay/mask-registry.js";
import { redactDataUri } from "../src/replay/redact.js";
import type { DecodedImage, JpegCodec } from "../src/replay/redact.js";

// SPEC-mobile §6.6: masked rects are blacked out on the frame BEFORE it
// enters the stream, rounded outward to whole dp, re-measured per capture,
// and fail-closed — an unmeasurable mask drops the frame.

describe("MaskRegistry", () => {
  it("measures every registered mask", async () => {
    const registry = new MaskRegistry();
    registry.register({ measure: async () => ({ x: 1, y: 2, width: 3, height: 4 }) });
    registry.register({ measure: async () => ({ x: 5, y: 6, width: 7, height: 8 }) });
    expect(await registry.measureAll()).toEqual([
      { x: 1, y: 2, width: 3, height: 4 },
      { x: 5, y: 6, width: 7, height: 8 },
    ]);
  });

  it("returns null when ANY mask cannot be measured (fail-closed)", async () => {
    const registry = new MaskRegistry();
    registry.register({ measure: async () => ({ x: 1, y: 2, width: 3, height: 4 }) });
    registry.register({ measure: async () => null });
    expect(await registry.measureAll()).toBeNull();
  });

  it("unregister removes the handle", async () => {
    const registry = new MaskRegistry();
    const unregister = registry.register({ measure: async () => null });
    unregister();
    expect(registry.isEmpty()).toBe(true);
    expect(await registry.measureAll()).toEqual([]);
  });
});

/**
 * Fake 4x4 "JPEG": the codec round-trips raw RGBA so the test can assert on
 * exact pixels without a real JPEG library (the codec is injected in
 * production too — jpeg-js as an optional peer).
 */
function fakeCodec(): JpegCodec & { images: DecodedImage[] } {
  const images: DecodedImage[] = [];
  return {
    images,
    decode(bytes: Uint8Array): DecodedImage {
      return { width: 4, height: 4, data: Uint8Array.from(bytes) };
    },
    encode(image: DecodedImage): { data: Uint8Array } {
      images.push(image);
      return { data: Uint8Array.from(image.data) };
    },
  };
}

function whitePixels(): Uint8Array {
  return new Uint8Array(4 * 4 * 4).fill(255);
}

function toDataUri(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

function pixelAt(data: Uint8Array, x: number, y: number): number[] {
  const i = (y * 4 + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

describe("redactDataUri", () => {
  it("blacks out the rect, rounding outward", () => {
    const codec = fakeCodec();
    const out = redactDataUri(codec, toDataUri(whitePixels()), [
      { x: 1.4, y: 1.6, width: 1.2, height: 0.8 }, // covers x∈[1,3), y∈[1,3) after outward rounding
    ]);
    expect(out).not.toBeNull();
    const redacted = codec.images[0]!.data;
    expect(pixelAt(redacted, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(redacted, 2, 2)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(redacted, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(redacted, 3, 3)).toEqual([255, 255, 255, 255]);
  });

  it("clamps rects that spill outside the image", () => {
    const codec = fakeCodec();
    const out = redactDataUri(codec, toDataUri(whitePixels()), [
      { x: -10, y: 3, width: 100, height: 100 },
    ]);
    expect(out).not.toBeNull();
    const redacted = codec.images[0]!.data;
    expect(pixelAt(redacted, 0, 3)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(redacted, 3, 3)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(redacted, 0, 2)).toEqual([255, 255, 255, 255]);
  });

  it("returns a data-URI and leaves unmasked frames untouched by rects=[]", () => {
    const codec = fakeCodec();
    const source = toDataUri(whitePixels());
    const out = redactDataUri(codec, source, []);
    expect(out).toMatch(/^data:image\/jpeg;base64,/);
    expect(codec.images[0]!.data.every((b) => b === 255)).toBe(true);
  });

  it("fails closed on an unparseable data-URI", () => {
    const codec = fakeCodec();
    expect(redactDataUri(codec, "not-a-data-uri", [])).toBeNull();
  });

  it("fails closed when the codec throws", () => {
    const codec: JpegCodec = {
      decode() {
        throw new Error("corrupt");
      },
      encode() {
        throw new Error("unreachable");
      },
    };
    expect(redactDataUri(codec, toDataUri(whitePixels()), [])).toBeNull();
  });
});
