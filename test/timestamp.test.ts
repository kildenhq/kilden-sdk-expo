import { describe, expect, it } from "vitest";

import { formatTimestamp, normalizeTimestamp } from "../src/timestamp.js";

const ISO_MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("timestamps", () => {
  it("formats with exactly three fractional digits, UTC, Z suffix", () => {
    expect(formatTimestamp(1_767_225_600_000)).toBe("2026-01-01T00:00:00.000Z");
    expect(formatTimestamp()).toMatch(ISO_MS_UTC_RE);
  });

  it("normalizes Date and string inputs to the spec form", () => {
    expect(normalizeTimestamp(new Date(1_767_225_600_123))).toBe("2026-01-01T00:00:00.123Z");
    expect(normalizeTimestamp("2026-01-02T03:04:05.678Z")).toBe("2026-01-02T03:04:05.678Z");
    expect(normalizeTimestamp("2026-01-02T03:04:05.678+02:00")).toBe(
      "2026-01-02T01:04:05.678Z",
    );
  });

  it("returns null on uninterpretable input", () => {
    expect(normalizeTimestamp("not a date")).toBeNull();
    expect(normalizeTimestamp(new Date(Number.NaN))).toBeNull();
  });
});
