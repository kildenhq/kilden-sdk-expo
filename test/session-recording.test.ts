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
    expect(client.getSessionRecordingConfig()).toEqual({
      enabled: true,
      sampleRate: 0.25,
      mobile: null,
    });
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

// The mobile sub-block (SPEC-mobile §5.1): parsed with the parent block's
// leniency one level down. Four shapes matter: field absent (old core),
// mobile omitted (project without the opt-in), enabled with a sample rate,
// and the block disappearing again (quota force-off → recorder stops).
describe("sessionRecording.mobile sub-block", () => {
  it("parses the mobile gate next to the web one", async () => {
    const client = newClient(
      decideTransport({
        flags: {},
        sessionRecording: { enabled: false, sampleRate: 1, mobile: { enabled: true, sampleRate: 0.5 } },
      }),
    );
    await client.getFeatureFlag("anything");
    expect(client.getSessionRecordingConfig()).toEqual({
      enabled: false,
      sampleRate: 1,
      mobile: { enabled: true, sampleRate: 0.5 },
    });
  });

  it("treats an absent mobile block as null (old core, or project without the opt-in)", async () => {
    const client = newClient(
      decideTransport({ flags: {}, sessionRecording: { enabled: true, sampleRate: 1 } }),
    );
    await client.getFeatureFlag("anything");
    expect(client.getSessionRecordingConfig()).toEqual({ enabled: true, sampleRate: 1, mobile: null });
  });

  it("treats a structurally invalid mobile block as absent", async () => {
    const client = newClient(
      decideTransport({
        flags: {},
        sessionRecording: { enabled: true, sampleRate: 1, mobile: ["not", "an", "object"] },
      }),
    );
    await client.getFeatureFlag("anything");
    expect(client.getSessionRecordingConfig()?.mobile).toBeNull();
  });

  it("falls back to sampleRate 1 on a bad mobile sample rate, still adopting the block", async () => {
    const client = newClient(
      decideTransport({
        flags: {},
        sessionRecording: { enabled: false, sampleRate: 0, mobile: { enabled: true, sampleRate: 7 } },
      }),
    );
    await client.getFeatureFlag("anything");
    expect(client.getSessionRecordingConfig()?.mobile).toEqual({ enabled: true, sampleRate: 1 });
  });

  it("a later poll without the mobile block clears it (quota force-off)", async () => {
    let withMobile = true;
    const transport: Transport = {
      async send(url): Promise<TransportResponse> {
        if (url.endsWith("/decide")) {
          const sessionRecording = withMobile
            ? { enabled: false, sampleRate: 1, mobile: { enabled: true, sampleRate: 1 } }
            : { enabled: false, sampleRate: 1 };
          return { status: 200, headers: {}, body: JSON.stringify({ flags: {}, sessionRecording }) };
        }
        return { status: 200, headers: {}, body: "" };
      },
    };
    const client = newClient(transport);
    await client.getFeatureFlag("anything");
    expect(client.getSessionRecordingConfig()?.mobile).toEqual({ enabled: true, sampleRate: 1 });

    withMobile = false;
    // personProperties bypasses the flag cache, forcing a fresh poll.
    await client.getFeatureFlag("anything", { personProperties: { fresh: true } });
    expect(client.getSessionRecordingConfig()?.mobile).toBeNull();
  });
});
