/**
 * Replays the frozen payload vectors from kilden-sdk-spec against the live
 * mock capture server, adapted to a CLIENT SDK (docs/27 §8): distinct_id is
 * identity state, not an argument, so the runner seeds storage instead of
 * passing ids per call.
 *
 * Client adaptations, all deliberate:
 * - track vectors: the vector's distinct_id is seeded as stored identity.
 * - identify vectors: the client adds $anon_distinct_id (docs/10 semantics);
 *   the runner asserts its shape, then removes it before the deep compare.
 * - alias vectors: previous_id is seeded as the current identity and
 *   alias(distinct_id) links the new id — same frozen $alias wire shape.
 * - Two vectors are unrepresentable on a stateful client and are skipped:
 *   track_empty_distinct_id_discarded and alias_empty_previous_id_discarded
 *   (a hydrated client never has an empty distinct_id; the equivalent
 *   guarantee is structural, not a validation path).
 * - The context provider is overridden to {} so events carry exactly the
 *   vector's properties ($lib etc. are asserted in unit tests instead).
 * - Every event carries $session_id (mobile sessions, SPEC-mobile.md); the
 *   runner asserts its shape, then removes it before the deep compare.
 */
import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { KildenClient } from "../../src/client.js";
import { MemoryStorage } from "../../src/storage.js";
import { K_ANON, K_DISTINCT } from "../../src/storage.js";
import type { Properties, TrackOptions } from "../../src/types.js";
import {
  ANON_ID_RE,
  ISO_MS_UTC_RE,
  MOCK_URL,
  PUBLIC_KEY,
  UUID_V7_RE,
  mockCaptured,
  mockReset,
  readVectors,
} from "../helpers.js";

interface PayloadVector {
  name: string;
  call: {
    method: "track" | "identify" | "alias";
    args: {
      distinct_id?: string;
      event?: string;
      properties?: Properties;
      traits?: Properties;
      previous_id?: string;
      opts?: { timestamp?: string; uuid?: string };
    };
  };
  expect_event?: Record<string, unknown>;
  expect?: "discarded";
}

const SKIPPED: Record<string, string> = {
  track_empty_distinct_id_discarded:
    "client SDK: distinct_id is hydrated state and can never be empty on track()",
  alias_empty_previous_id_discarded:
    "client SDK: the current distinct_id (previous_id) can never be empty",
};

const { vectors } = readVectors<{ vectors: PayloadVector[] }>("payload.json");

function newClient(storage: MemoryStorage): KildenClient {
  return new KildenClient(PUBLIC_KEY, {
    apiHost: MOCK_URL,
    flushAt: 1000,
    flushIntervalMs: 0,
    requestTimeoutMs: 5000,
    storage,
    context: () => ({}),
    getRandomValues: (array) => {
      randomFillSync(array);
      return array;
    },
  });
}

function toTrackOptions(opts?: { timestamp?: string; uuid?: string }): TrackOptions | undefined {
  if (!opts) return undefined;
  const result: TrackOptions = {};
  if (opts.timestamp !== undefined) result.timestamp = opts.timestamp;
  if (opts.uuid !== undefined) result.uuid = opts.uuid;
  return result;
}

function assertPlaceholders(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  const normalized: Record<string, unknown> = { ...expected };
  for (const [key, value] of Object.entries(expected)) {
    if (value === "<uuid_v7>") {
      expect(actual[key], `${key} should be a v7 uuid`).toMatch(UUID_V7_RE);
      normalized[key] = actual[key];
    } else if (value === "<iso8601_utc_ms>") {
      expect(actual[key], `${key} should be an ISO 8601 UTC ms timestamp`).toMatch(
        ISO_MS_UTC_RE,
      );
      normalized[key] = actual[key];
    }
  }
  expect(actual).toEqual(normalized);
}

describe("payload vectors (client adaptation)", () => {
  for (const vector of vectors) {
    const skipReason = SKIPPED[vector.name];
    const runner = skipReason ? it.skip : it;

    runner(`${vector.name}${skipReason ? ` — ${skipReason}` : ""}`, async () => {
      await mockReset();
      const storage = new MemoryStorage();
      const { method, args } = vector.call;

      if (method === "track" && args.distinct_id) {
        await storage.setItem(K_ANON, args.distinct_id);
        await storage.setItem(K_DISTINCT, args.distinct_id);
      }
      if (method === "alias" && args.previous_id) {
        await storage.setItem(K_ANON, args.previous_id);
        await storage.setItem(K_DISTINCT, args.previous_id);
      }

      const client = newClient(storage);
      if (method === "track") {
        client.track(args.event as string, args.properties, toTrackOptions(args.opts));
      } else if (method === "identify") {
        client.identify(args.distinct_id as string, args.traits);
      } else {
        client.alias(args.distinct_id as string);
      }
      await client.flush();
      await client.close();

      const { events } = await mockCaptured();

      if (vector.expect === "discarded") {
        expect(events).toHaveLength(0);
        return;
      }

      expect(events).toHaveLength(1);
      const actual = { ...(events[0] as unknown as Record<string, unknown>) };
      const expected = { ...(vector.expect_event as Record<string, unknown>) };

      const properties = { ...(actual["properties"] as Record<string, unknown>) };
      expect(properties["$session_id"], "$session_id shape").toMatch(UUID_V7_RE);
      delete properties["$session_id"];
      if (method === "identify") {
        expect(properties["$anon_distinct_id"], "$anon_distinct_id shape").toMatch(ANON_ID_RE);
        delete properties["$anon_distinct_id"];
      }
      actual["properties"] = properties;

      assertPlaceholders(actual, expected);
    });
  }

  it("covers every vector (skips are explicit)", () => {
    const known = new Set(vectors.map((vector) => vector.name));
    for (const name of Object.keys(SKIPPED)) {
      expect(known.has(name), `skipped vector ${name} no longer exists in the spec`).toBe(true);
    }
  });
});
