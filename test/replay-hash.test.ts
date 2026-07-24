import { describe, expect, it } from "vitest";

import { djb2 } from "../src/replay/hash.js";

// SPEC-mobile §6.4: frame dedup hashes the JPEG data-URI with djb2. Cheap on
// strings of hundreds of KB, and collisions only cost one dropped frame.

describe("djb2", () => {
  it("is deterministic", () => {
    expect(djb2("data:image/jpeg;base64,AAA")).toBe(djb2("data:image/jpeg;base64,AAA"));
  });

  it("distinguishes nearby strings", () => {
    expect(djb2("data:image/jpeg;base64,AAA")).not.toBe(djb2("data:image/jpeg;base64,AAB"));
  });

  it("stays a 32-bit unsigned integer", () => {
    const h = djb2("x".repeat(100_000));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
