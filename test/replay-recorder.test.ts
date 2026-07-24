import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReplayRecorder } from "../src/replay/recorder.js";
import type { RecorderDeps } from "../src/replay/recorder.js";
import { K_REPLAY_SAMPLE } from "../src/replay/sampling.js";
import { silentLogger } from "../src/log.js";
import { MemoryStorage } from "../src/storage.js";
import type { TransportResponse } from "../src/types.js";

// SPEC-mobile §6: gates, capture policy (throttle ≥1s, heartbeat ≥10s, hash
// dedup, caps 300 frames / 15 min), chunking (512KB / 30s), lifecycle
// (background flush+stop, rotation cut, optOut discard) and privacy controls
// (denylist, pause/resume, fail-closed masking).

interface SentChunk {
  url: string;
  headers: Record<string, string>;
  events: Array<{ type: number; timestamp: number }>;
}

function harness(overrides: Partial<RecorderDeps> = {}) {
  const sent: SentChunk[] = [];
  const storage = new MemoryStorage();
  let frame = 0;
  const deps: RecorderDeps = {
    storage,
    transport: {
      async send(url, body, headers): Promise<TransportResponse> {
        sent.push({ url, headers, events: JSON.parse(body) });
        return { status: 200, headers: {}, body: "" };
      },
    },
    replayUrl: "https://ingest.test/replay",
    writeKey: "wk_test_public",
    platform: "ios",
    sdkVersion: "0.3.0",
    getDistinctId: async () => "anon_1",
    getSessionId: () => "019078f0-0000-7000-8000-0000000000aa",
    captureScreen: async () => ({
      dataUri: `data:image/jpeg;base64,FRAME${frame++}`,
      width: 390,
      height: 844,
    }),
    getRandomValues: (array) => {
      // Deterministic uuidv7 randomness is irrelevant here.
      array.fill(7);
      return array;
    },
    log: silentLogger,
    ...overrides,
  };
  const recorder = new ReplayRecorder(deps);
  return { recorder, sent, storage, deps };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1720000000000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gates", () => {
  it("does not record when sampling says no", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 0 }, "home");
    expect(recorder.isRecording()).toBe(false);
    await recorder.stop();
    expect(sent).toHaveLength(0);
  });

  it("records when the gate is open and sampling says yes", async () => {
    const { recorder } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    expect(recorder.isRecording()).toBe(true);
    await recorder.stop();
  });

  it("never starts on a disabled gate", async () => {
    const { recorder } = harness();
    await recorder.start({ enabled: false, sampleRate: 1 }, "home");
    expect(recorder.isRecording()).toBe(false);
  });

  it("sampling is sticky per session across recordings", async () => {
    const { recorder, storage } = harness();
    await storage.setItem(
      K_REPLAY_SAMPLE,
      JSON.stringify({ sid: "019078f0-0000-7000-8000-0000000000aa", sampled: false }),
    );
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    expect(recorder.isRecording()).toBe(false);
  });
});

describe("capture policy", () => {
  it("the recording starts with Meta + custom meta + FullSnapshot of the first frame", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    await recorder.stop();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events.map((e) => e.type)).toEqual([4, 5, 2]);
  });

  it("throttles frames to one per second", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    await recorder.captureNow("test"); // same ms as the start frame → throttled
    await recorder.stop();
    expect(sent[0]!.events.map((e) => e.type)).toEqual([4, 5, 2]);
  });

  it("drops identical frames by hash", async () => {
    let calls = 0;
    const { recorder, sent } = harness({
      captureScreen: async () => {
        calls++;
        return { dataUri: "data:image/jpeg;base64,SAME", width: 390, height: 844 };
      },
    });
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    vi.setSystemTime(1720000002000);
    await recorder.captureNow("test");
    await recorder.stop();
    expect(calls).toBe(2);
    // Only the initial FullSnapshot made it: the identical frame was dropped.
    expect(sent[0]!.events.map((e) => e.type)).toEqual([4, 5, 2]);
  });

  it("the heartbeat captures at 10s intervals", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    await vi.advanceTimersByTimeAsync(10_000);
    await recorder.stop();
    const types = sent.flatMap((c) => c.events.map((e) => e.type));
    // start (4,5,2) + one heartbeat mutation (3)
    expect(types).toEqual([4, 5, 2, 3]);
  });

  it("stops at the frame cap", async () => {
    const { recorder } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    for (let i = 0; i < 400; i++) {
      vi.setSystemTime(1720000000000 + (i + 1) * 1100);
      await recorder.captureNow("test");
    }
    expect(recorder.isRecording()).toBe(false);
  });

  it("stops at the 15 minute cap", async () => {
    const { recorder } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    vi.setSystemTime(1720000000000 + 15 * 60 * 1000 + 1);
    await recorder.captureNow("test");
    expect(recorder.isRecording()).toBe(false);
  });
});

describe("navigation and touches", () => {
  it("a screen change emits Meta + FullSnapshot and updates the chunk page url", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    vi.setSystemTime(1720000002000);
    await recorder.onScreenChange("checkout");
    await recorder.stop();
    const types = sent[0]!.events.map((e) => e.type);
    expect(types).toEqual([4, 5, 2, 4, 2]);
    // The chunk's page url is the FIRST event's screen (home).
    expect(sent[0]!.headers["X-Kilden-Page-Url"]).toBe(
      encodeURIComponent("kilden-app://screen/home"),
    );
  });

  it("a denylisted screen produces no frames while current", async () => {
    const { recorder, sent } = harness({ replayDenylist: ["checkout"] });
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    vi.setSystemTime(1720000002000);
    await recorder.onScreenChange("checkout");
    vi.setSystemTime(1720000004000);
    await recorder.captureNow("test");
    vi.setSystemTime(1720000006000);
    await recorder.onScreenChange("home");
    await recorder.stop();
    const types = sent[0]!.events.map((e) => e.type);
    // start on home (4,5,2) … checkout produces NOTHING … back on home (4,2)
    expect(types).toEqual([4, 5, 2, 4, 2]);
  });

  it("touches while recording become clicks; touches while paused do not", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    recorder.onTouch(10, 20);
    recorder.pause();
    recorder.onTouch(30, 40);
    recorder.resume();
    await recorder.stop();
    const clicks = sent[0]!.events.filter((e) => e.type === 3);
    expect(clicks).toHaveLength(1);
  });
});

describe("chunking and lifecycle", () => {
  it("flushes on the 30s interval and increments chunk_index", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["X-Kilden-Chunk-Index"]).toBe("0");
    vi.setSystemTime(Date.now() + 1000);
    await recorder.captureNow("test");
    await recorder.stop();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers["X-Kilden-Chunk-Index"]).toBe("1");
  });

  it("background stops the recording and flushes the tail", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    await recorder.onBackground();
    expect(recorder.isRecording()).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("a session rotation cuts the recording (a chunk never crosses sessions)", async () => {
    let session = "019078f0-0000-7000-8000-0000000000aa";
    const { recorder, sent } = harness({ getSessionId: () => session });
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    session = "019078f0-0000-7000-8000-0000000000bb";
    vi.setSystemTime(1720000002000);
    await recorder.captureNow("test");
    expect(recorder.isRecording()).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["X-Kilden-Session-Id"]).toBe(
      "019078f0-0000-7000-8000-0000000000aa",
    );
  });

  it("discard() transmits nothing (the optOut path)", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    recorder.discard();
    expect(recorder.isRecording()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("two recordings of one session carry distinct recording ids", async () => {
    const { recorder, sent } = harness();
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    await recorder.stop();
    vi.setSystemTime(1720000005000);
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    await recorder.stop();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers["X-Kilden-Recording-Id"]).not.toBe(
      sent[1]!.headers["X-Kilden-Recording-Id"],
    );
    expect(sent[1]!.headers["X-Kilden-Chunk-Index"]).toBe("0");
  });
});

describe("masking hook", () => {
  it("a redactor that returns null drops the frame (fail-closed)", async () => {
    const { recorder, sent } = harness({
      redact: async (dataUri) =>
        dataUri.endsWith("FRAME0") ? dataUri : null, // only the first frame survives
    });
    await recorder.start({ enabled: true, sampleRate: 1 }, "home");
    vi.setSystemTime(1720000002000);
    await recorder.captureNow("test");
    await recorder.stop();
    expect(sent[0]!.events.map((e) => e.type)).toEqual([4, 5, 2]);
  });
});
