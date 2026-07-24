import { describe, expect, it } from "vitest";

import { RrwebSynthesizer } from "../src/replay/synthesize.js";
import { readVectors } from "./helpers.js";

// SPEC-mobile §6.5/§6.8: the synthesis is pinned byte-exactly by the spec's
// vectors. Each case feeds a capture timeline and lists the exact rrweb
// events the SDK must produce, compared under deep equality.

interface VectorEvent {
  kind: "frame" | "screenChange" | "touch" | "resize";
  at: number;
  dataUri?: string;
  screen?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface VectorCase {
  name: string;
  input: {
    platform: "ios" | "android";
    sdkVersion: string;
    width: number;
    height: number;
    initialScreen: string | null;
    events: VectorEvent[];
  };
  expected: unknown[];
}

const { cases } = readVectors<{ cases: VectorCase[] }>("mobile-replay.json");

function run(input: VectorCase["input"]): unknown[] {
  const synth = new RrwebSynthesizer({
    platform: input.platform,
    sdkVersion: input.sdkVersion,
    width: input.width,
    height: input.height,
    screen: input.initialScreen,
  });
  const out: unknown[] = [];
  for (const event of input.events) {
    switch (event.kind) {
      case "frame":
        out.push(...synth.frame(event.dataUri!, event.at));
        break;
      case "screenChange":
        out.push(...synth.screenChange(event.screen!, event.dataUri!, event.at));
        break;
      case "touch":
        out.push(...synth.touch(event.x!, event.y!, event.at));
        break;
      case "resize":
        out.push(...synth.resize(event.width!, event.height!, event.at));
        break;
    }
  }
  return out;
}

describe("rrweb synthesis (SPEC-mobile §6.5 vectors)", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, vector) => {
    expect(run(vector.input)).toEqual(vector.expected);
  });

  it("a touch before any frame emits nothing (no document to click on)", () => {
    const synth = new RrwebSynthesizer({
      platform: "ios",
      sdkVersion: "0.3.0",
      width: 390,
      height: 844,
      screen: "home",
    });
    expect(synth.touch(10, 10, 1720000000000)).toEqual([]);
  });

  it("a resize before any frame updates dimensions for the eventual Meta, silently", () => {
    const synth = new RrwebSynthesizer({
      platform: "ios",
      sdkVersion: "0.3.0",
      width: 390,
      height: 844,
      screen: "home",
    });
    expect(synth.resize(844, 390, 1720000000000)).toEqual([]);
    const events = synth.frame("data:image/jpeg;base64,F0", 1720000001000) as Array<{
      type: number;
      data: { width?: number; height?: number };
    }>;
    expect(events[0]?.data.width).toBe(844);
    expect(events[0]?.data.height).toBe(390);
  });
});
