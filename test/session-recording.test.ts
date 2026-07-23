import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { KildenClient } from "../src/client.js";
import { MemoryStorage } from "../src/storage.js";
import type { InitOptions, Transport, TransportResponse } from "../src/types.js";

const fill = (array: Uint8Array): Uint8Array => {
  randomFillSync(array);
  return array;
};

function decideTransport(body: unknown): Transport {
  return {
    async send(url): Promise<TransportResponse> {
      if (url.endsWith("/decide")) {
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      }
      return { status: 200, headers: {}, body: "" };
    },
  };
}

function newClient(transport: Transport, options: Partial<InitOptions> = {}): KildenClient {
  return new KildenClient("wk_test_public", {
    flushAt: 1000,
    flushIntervalMs: 0,
    storage: new MemoryStorage(),
    transport,
    context: () => ({}),
    getRandomValues: fill,
    trackAppLifecycle: false,
    ...options,
  });
}

describe("sessionRecording config from /decide", () => {
  it("parses sessionRecording alongside flags", async () => {
    const client = newClient(
      decideTransport({
        flags: { welcome: true },
        sessionRecording: { enabled: true, sampleRate: 0.25 },
      }),
    );
    await client.getFeatureFlag("welcome");
    expect(client.getSessionRecordingConfig()).toEqual({ enabled: true, sampleRate: 0.25 });
  });

  it("tolerates responses without the field (backward compat)", async () => {
    const client = newClient(decideTransport({ flags: { welcome: true } }));
    await client.getFeatureFlag("welcome");
    expect(client.getSessionRecordingConfig()).toBeNull();
  });

  it("tolerates a malformed sessionRecording payload", async () => {
    const client = newClient(
      decideTransport({ flags: {}, sessionRecording: "definitely-not-an-object" }),
    );
    await client.getFeatureFlag("anything");
    expect(client.getSessionRecordingConfig()).toBeNull();
  });

  it("returns null before any /decide round trip", () => {
    const client = newClient(decideTransport({ flags: {} }));
    expect(client.getSessionRecordingConfig()).toBeNull();
  });
});
