import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { isCanonicalUuid, newAnonymousId, uuidv7 } from "../src/uuid.js";

const fill = (array: Uint8Array): Uint8Array => {
  randomFillSync(array);
  return array;
};

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("produces lowercase canonical v7 uuids", () => {
    for (let i = 0; i < 200; i++) {
      expect(uuidv7(fill)).toMatch(UUID_V7_RE);
    }
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const now = 1_752_500_000_123;
    const id = uuidv7(fill, now);
    const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(ms).toBe(now);
  });

  it("is deterministic given a deterministic random source", () => {
    const zero = (array: Uint8Array): Uint8Array => array.fill(0);
    expect(uuidv7(zero, 0)).toBe(uuidv7(zero, 0));
  });

  it("newAnonymousId uses the anon_ prefix", () => {
    expect(newAnonymousId(fill)).toMatch(/^anon_/);
  });

  it("isCanonicalUuid accepts any RFC 4122 form and rejects garbage", () => {
    expect(isCanonicalUuid("0197fa10-7a2b-4c3d-8e4f-5a6b7c8d9e0f")).toBe(true);
    expect(isCanonicalUuid("0197FA10-7A2B-7C3D-8E4F-5A6B7C8D9E0F")).toBe(true);
    expect(isCanonicalUuid("not-a-uuid")).toBe(false);
    expect(isCanonicalUuid("")).toBe(false);
  });
});
