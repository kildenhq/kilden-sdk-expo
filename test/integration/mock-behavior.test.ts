/**
 * Transport-level behavior against the live mock server: retry policy,
 * Retry-After, the "any 2xx is success and the body is never parsed"
 * contract, identity token headers and /decide.
 */
import { randomFillSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { KildenClient } from "../../src/client.js";
import { MemoryStorage } from "../../src/storage.js";
import { FetchTransport } from "../../src/transport.js";
import type { InitOptions } from "../../src/types.js";
import {
  MOCK_URL,
  PUBLIC_KEY,
  mockCaptured,
  mockFail,
  mockFlags,
  mockReset,
} from "../helpers.js";

function newClient(options: Partial<InitOptions> = {}): KildenClient {
  return new KildenClient(PUBLIC_KEY, {
    apiHost: MOCK_URL,
    flushAt: 1000,
    flushIntervalMs: 0,
    requestTimeoutMs: 3000,
    storage: new MemoryStorage(),
    context: () => ({}),
    getRandomValues: (array) => {
      randomFillSync(array);
      return array;
    },
    ...options,
  });
}

describe("mock server behavior", () => {
  beforeEach(async () => {
    await mockReset();
  });

  it("retries a 429 honoring Retry-After and delivers", async () => {
    await mockFail({ times: 1, status: 429, retry_after: 1 });
    const client = newClient();
    client.track("resilient");
    const started = Date.now();
    await client.flush();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const { events } = await mockCaptured();
    expect(events).toHaveLength(1);
    expect(client.dropped).toBe(0);
  });

  it("treats a corrupt 200 body as success — the body is never parsed", async () => {
    await mockFail({ times: 1, mode: "corrupt" });
    const client = newClient();
    client.track("kept");
    await client.flush();
    expect(client.dropped).toBe(0);
  });

  it("drops after exhausting retries on persistent 500s", async () => {
    await mockFail({ times: 10, status: 500 });
    const client = newClient();
    client.track("doomed");
    await client.flush();
    expect(client.dropped).toBe(1);
    const { events } = await mockCaptured();
    expect(events).toHaveLength(0);
  });

  it("drops immediately on a non-retryable 400-class response", async () => {
    await mockFail({ times: 1, status: 413 });
    const client = newClient();
    client.track("too_big");
    await client.flush();
    expect(client.dropped).toBe(1);
  });

  it("survives a connection cut mid-response and retries", async () => {
    await mockFail({ times: 1, mode: "cut" });
    const client = newClient();
    client.track("cut_once");
    await client.flush();
    expect(client.dropped).toBe(0);
    const { events } = await mockCaptured();
    expect(events).toHaveLength(1);
  });

  it("sends the identity token as Authorization: Bearer", async () => {
    // The mock only records Content-Type/Content-Encoding/User-Agent, so the
    // Authorization header is asserted through a spying transport while the
    // request still goes to the real mock server.
    const sent: Array<Record<string, string>> = [];
    const inner = new FetchTransport();
    const client = newClient({
      identityToken: "header.payload.signature",
      transport: {
        send(url, body, headers, timeoutMs) {
          sent.push(headers);
          return inner.send(url, body, headers, timeoutMs);
        },
      },
    });
    client.track("authed");
    await client.flush();
    const { events } = await mockCaptured();
    expect(events).toHaveLength(1);
    expect(sent[0]?.["Authorization"]).toBe("Bearer header.payload.signature");
  });

  it("evaluates flags via /decide with the public key", async () => {
    await mockFlags([
      { key: "checkout_v2", active: true, rollout_percentage: 100 },
      { key: "banner", active: false },
    ]);
    const client = newClient();
    await expect(client.isFeatureEnabled("checkout_v2")).resolves.toBe(true);
    await expect(client.getFeatureFlag("banner")).resolves.toBe(false);
    await expect(client.getFeatureFlag("missing", { default: "fallback" })).resolves.toBe(
      "fallback",
    );
  });

  it("emits $feature_flag_called once per flag value", async () => {
    await mockFlags([{ key: "exposed_flag", active: true, rollout_percentage: 100 }]);
    const client = newClient();
    await client.getFeatureFlag("exposed_flag");
    await client.getFeatureFlag("exposed_flag");
    await client.flush();
    const { events } = await mockCaptured();
    const exposures = events.filter((event) => event.event === "$feature_flag_called");
    expect(exposures).toHaveLength(1);
    expect(exposures[0]?.properties["$flag_key"]).toBe("exposed_flag");
    expect(exposures[0]?.properties["$flag_value"]).toBe(true);
  });

  it("refreshes the identity token on 401 and retries the batch", async () => {
    await mockFail({ times: 1, status: 401 });
    let calls = 0;
    const client = newClient({
      identityToken: "stale.token.sig",
      getIdentityToken: async () => {
        calls += 1;
        return "fresh.token.sig";
      },
    });
    client.track("reauthed");
    await client.flush();
    expect(calls).toBe(1);
    expect(client.dropped).toBe(0);
    const { events } = await mockCaptured();
    expect(events).toHaveLength(1);
  });
});
