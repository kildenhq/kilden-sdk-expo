import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { KildenClient } from "../src/client.js";
import { MemoryStorage } from "../src/storage.js";
import type { InitOptions, Transport, TransportResponse } from "../src/types.js";

// The client-level wiring (SPEC-mobile §6.1): sessionReplay: true is only
// half the gate — recording starts when /decide serves the project's mobile
// block, captures on screen changes, and everything lands on POST /replay
// with the platform header.

const fill = (array: Uint8Array): Uint8Array => {
  randomFillSync(array);
  return array;
};

function harness(mobile: { enabled: boolean; sampleRate: number } | null) {
  const replayPosts: Array<{ headers: Record<string, string>; body: string }> = [];
  const transport: Transport = {
    async send(url, body, headers): Promise<TransportResponse> {
      if (url.endsWith("/decide")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            flags: {},
            sessionRecording: {
              enabled: false,
              sampleRate: 1,
              ...(mobile ? { mobile } : {}),
            },
          }),
        };
      }
      if (url.endsWith("/replay")) {
        replayPosts.push({ headers, body });
      }
      return { status: 200, headers: {}, body: "{}" };
    },
  };
  let frame = 0;
  const options: InitOptions = {
    flushAt: 1000,
    flushIntervalMs: 0,
    storage: new MemoryStorage(),
    transport,
    context: () => ({}),
    getRandomValues: fill,
    trackAppLifecycle: false,
    sessionReplay: true,
    replayPlatform: "ios",
    captureScreen: async () => ({
      dataUri: `data:image/jpeg;base64,FRAME${frame++}`,
      width: 390,
      height: 844,
    }),
  };
  return { client: new KildenClient("wk_test_public", options), replayPosts };
}

describe("client replay wiring", () => {
  it("records when /decide serves the mobile gate and ships chunks to /replay", async () => {
    const { client, replayPosts } = harness({ enabled: true, sampleRate: 1 });
    // The first gate poll runs right after hydration; give its promise chain
    // a real tick, then navigate (an on-change capture) and close (flush).
    await new Promise((r) => setTimeout(r, 50));
    client.screen("checkout");
    await new Promise((r) => setTimeout(r, 10));
    await client.close();
    expect(replayPosts.length).toBeGreaterThan(0);
    const headers = replayPosts[0]!.headers;
    expect(headers["X-Kilden-Platform"]).toBe("ios");
    expect(headers["X-Kilden-Write-Key"]).toBe("wk_test_public");
    const events = JSON.parse(replayPosts[0]!.body) as Array<{ type: number }>;
    // Recording start: Meta + kilden_mobile_meta + FullSnapshot lead.
    expect(events.slice(0, 3).map((e) => e.type)).toEqual([4, 5, 2]);
  });

  it("never records without the mobile block (old core / project without opt-in)", async () => {
    const { client, replayPosts } = harness(null);
    await new Promise((r) => setTimeout(r, 50));
    client.screen("checkout");
    await client.close();
    expect(replayPosts).toHaveLength(0);
  });

  it("never records when the mobile gate is disabled", async () => {
    const { client, replayPosts } = harness({ enabled: false, sampleRate: 1 });
    await new Promise((r) => setTimeout(r, 50));
    await client.close();
    expect(replayPosts).toHaveLength(0);
  });
});
