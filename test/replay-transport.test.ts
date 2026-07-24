import { describe, expect, it } from "vitest";

import { chunkHeaders, sendChunk } from "../src/replay/transport.js";
import type { ChunkMeta } from "../src/replay/transport.js";
import type { Transport, TransportResponse } from "../src/types.js";

// SPEC-mobile §6.7: the web chunk transport plus X-Kilden-Platform. Body is
// the uncompressed JSON array of rrweb events; metadata travels in headers
// (never the query string); any 2xx is success and the body is never parsed.

const meta: ChunkMeta = {
  writeKey: "wk_test_public",
  sessionId: "019078f0-0000-7000-8000-0000000000aa",
  recordingId: "019078f0-0000-7000-8000-0000000000bb",
  distinctId: "usuário café",
  chunkIndex: 3,
  pageUrl: "kilden-app://screen/product/[id]",
  hasError: true,
  firstEventAt: 1720000000000,
  lastEventAt: 1720000005000,
  platform: "ios",
};

describe("chunk headers", () => {
  it("carries the full metadata contract, URI-encoding what headers reject", () => {
    expect(chunkHeaders(meta)).toEqual({
      "Content-Type": "application/json",
      "X-Kilden-Write-Key": "wk_test_public",
      "X-Kilden-Session-Id": "019078f0-0000-7000-8000-0000000000aa",
      "X-Kilden-Recording-Id": "019078f0-0000-7000-8000-0000000000bb",
      "X-Kilden-Distinct-Id": "usu%C3%A1rio%20caf%C3%A9",
      "X-Kilden-Chunk-Index": "3",
      "X-Kilden-Page-Url": "kilden-app%3A%2F%2Fscreen%2Fproduct%2F%5Bid%5D",
      "X-Kilden-Has-Error": "1",
      "X-Kilden-First-Event-At": "1720000000000",
      "X-Kilden-Last-Event-At": "1720000005000",
      "X-Kilden-Platform": "ios",
    });
  });
});

function transportReturning(...statuses: number[]): { transport: Transport; calls: string[] } {
  const calls: string[] = [];
  const transport: Transport = {
    async send(url, body): Promise<TransportResponse> {
      calls.push(body);
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
      return { status, headers: {}, body: "" };
    },
  };
  return { transport, calls };
}

describe("sendChunk", () => {
  it("delivers on first 2xx", async () => {
    const { transport, calls } = transportReturning(200);
    const ok = await sendChunk(transport, "https://ingest.test/replay", meta, "[]", async () => {});
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("retries with backoff and succeeds (idempotent server-side)", async () => {
    const { transport, calls } = transportReturning(0, 502, 200);
    const waits: number[] = [];
    const ok = await sendChunk(transport, "https://ingest.test/replay", meta, "[]", async (ms) => {
      waits.push(ms);
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("gives up after three attempts", async () => {
    const { transport, calls } = transportReturning(500);
    const ok = await sendChunk(transport, "https://ingest.test/replay", meta, "[]", async () => {});
    expect(ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("never retries a 4xx (the chunk is malformed, a retry cannot fix it)", async () => {
    const { transport, calls } = transportReturning(400);
    const ok = await sendChunk(transport, "https://ingest.test/replay", meta, "[]", async () => {});
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
