import { describe, expect, it } from "vitest";

import { Batcher } from "../src/batcher.js";
import { silentLogger } from "../src/log.js";
import type { EventPayload, Transport, TransportResponse } from "../src/types.js";

function event(name: string): EventPayload {
  return {
    uuid: "0197fa10-7a2b-7c3d-8e4f-5a6b7c8d9e0f",
    event: name,
    distinct_id: "user_42",
    properties: {},
    timestamp: "2026-07-14T12:00:00.000Z",
  };
}

interface Call {
  body: string;
  headers: Record<string, string>;
}

function makeTransport(responses: Array<Partial<TransportResponse>>): {
  transport: Transport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: Transport = {
    async send(_url, body, headers) {
      calls.push({ body, headers });
      const next = responses.shift() ?? { status: 200 };
      return { status: next.status ?? 200, headers: next.headers ?? {}, body: next.body ?? "" };
    },
  };
  return { transport, calls };
}

function makeBatcher(
  transport: Transport,
  overrides: { getToken?: () => string | null; onUnauthorized?: () => Promise<boolean> } = {},
): { batcher: Batcher; sleeps: number[] } {
  const sleeps: number[] = [];
  const batcher = new Batcher(
    {
      url: "http://mock/capture",
      writeKey: "wk_test_public",
      transport,
      timeoutMs: 1000,
      log: silentLogger,
      getToken: overrides.getToken ?? (() => null),
      onUnauthorized: overrides.onUnauthorized ?? (async () => false),
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5, // jitter factor exactly 1.0
      now: () => 1_767_225_600_000,
    },
  );
  return { batcher, sleeps };
}

describe("batcher", () => {
  it("succeeds on any 2xx without touching the body", async () => {
    const { transport, calls } = makeTransport([{ status: 207, body: "<<< not json" }]);
    const { batcher, sleeps } = makeBatcher(transport);
    await batcher.send([event("one")]);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(batcher.dropped).toBe(0);
  });

  it("retries retryable statuses with the frozen backoff (500ms, 1s, 2s at jitter 1.0)", async () => {
    const { transport, calls } = makeTransport([
      { status: 500 },
      { status: 503 },
      { status: 0 },
      { status: 200 },
    ]);
    const { batcher, sleeps } = makeBatcher(transport);
    await batcher.send([event("one")]);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(batcher.dropped).toBe(0);
  });

  it("drops after 3 retries are exhausted", async () => {
    const { transport, calls } = makeTransport([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const { batcher } = makeBatcher(transport);
    await batcher.send([event("one"), event("two")]);
    expect(calls).toHaveLength(4);
    expect(batcher.dropped).toBe(2);
  });

  it("honors Retry-After on 429 without jitter", async () => {
    const { transport } = makeTransport([
      { status: 429, headers: { "retry-after": "7" } },
      { status: 200 },
    ]);
    const { batcher, sleeps } = makeBatcher(transport);
    await batcher.send([event("one")]);
    expect(sleeps).toEqual([7000]);
  });

  it("does not retry other 4xx statuses", async () => {
    const { transport, calls } = makeTransport([{ status: 400 }]);
    const { batcher } = makeBatcher(transport);
    await batcher.send([event("one")]);
    expect(calls).toHaveLength(1);
    expect(batcher.dropped).toBe(1);
  });

  it("drops on 401 when no refresher can produce a new token", async () => {
    const { transport, calls } = makeTransport([{ status: 401 }]);
    const { batcher } = makeBatcher(transport);
    await batcher.send([event("one")]);
    expect(calls).toHaveLength(1);
    expect(batcher.dropped).toBe(1);
  });

  it("retries immediately on 401 after a successful token refresh, once", async () => {
    let token = "stale";
    const { transport, calls } = makeTransport([{ status: 401 }, { status: 200 }]);
    const { batcher, sleeps } = makeBatcher(transport, {
      getToken: () => token,
      onUnauthorized: async () => {
        token = "fresh";
        return true;
      },
    });
    await batcher.send([event("one")]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(calls[1]?.headers["Authorization"]).toBe("Bearer fresh");
    expect(batcher.dropped).toBe(0);
  });

  it("chunks batches above 1000 events", async () => {
    const { transport, calls } = makeTransport([{ status: 200 }, { status: 200 }]);
    const { batcher } = makeBatcher(transport);
    const events = Array.from({ length: 1500 }, (_, i) => event(`e${i}`));
    await batcher.send(events);
    expect(calls).toHaveLength(2);
    const first = JSON.parse(calls[0]?.body ?? "") as { batch: unknown[] };
    const second = JSON.parse(calls[1]?.body ?? "") as { batch: unknown[] };
    expect(first.batch).toHaveLength(1000);
    expect(second.batch).toHaveLength(500);
  });

  it("builds the exact wire payload: write_key, sent_at, batch", async () => {
    const { transport, calls } = makeTransport([{ status: 200 }]);
    const { batcher } = makeBatcher(transport);
    await batcher.send([event("shape")]);
    const body = JSON.parse(calls[0]?.body ?? "") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["batch", "sent_at", "write_key"]);
    expect(body["write_key"]).toBe("wk_test_public");
    expect(body["sent_at"]).toBe("2026-01-01T00:00:00.000Z");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.headers["User-Agent"]).toMatch(/^kilden-expo\//);
  });

  it("drops a single event that exceeds 5 MiB on its own", async () => {
    const { transport, calls } = makeTransport([]);
    const { batcher } = makeBatcher(transport);
    const big = event("big");
    big.properties = { blob: "x".repeat(6 * 1024 * 1024) };
    await batcher.send([big]);
    expect(calls).toHaveLength(0);
    expect(batcher.dropped).toBe(1);
  });
});
