import { describe, expect, it } from "vitest";

import { FlagClient } from "../src/flags.js";
import { silentLogger } from "../src/log.js";
import type { FlagValue, Transport } from "../src/types.js";

interface DecideCall {
  body: Record<string, unknown>;
}

function makeFlagClient(
  respond: (call: DecideCall) => { status: number; body: string },
  overrides: { now?: () => number } = {},
): { flags: FlagClient; calls: DecideCall[]; exposures: Array<[string, FlagValue]> } {
  const calls: DecideCall[] = [];
  const exposures: Array<[string, FlagValue]> = [];
  const transport: Transport = {
    async send(_url, body) {
      const call = { body: JSON.parse(body) as Record<string, unknown> };
      calls.push(call);
      const response = respond(call);
      return { status: response.status, headers: {}, body: response.body };
    },
  };
  const flags = new FlagClient({
    url: "http://mock/decide",
    writeKey: "wk_test_public",
    transport,
    timeoutMs: 1000,
    log: silentLogger,
    getDistinctId: async () => "user_42",
    onExposure: (key, value) => exposures.push([key, value]),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return { flags, calls, exposures };
}

const OK = (flags: Record<string, FlagValue>) => ({
  status: 200,
  body: JSON.stringify({ flags, sessionRecording: { enabled: false, sampleRate: 0 } }),
});

describe("flags", () => {
  it("returns the flag value and caches for 30s", async () => {
    let now = 0;
    const { flags, calls } = makeFlagClient(() => OK({ checkout: "variant_b" }), {
      now: () => now,
    });
    await expect(flags.getFeatureFlag("checkout")).resolves.toBe("variant_b");
    now = 29_000;
    await expect(flags.getFeatureFlag("checkout")).resolves.toBe("variant_b");
    expect(calls).toHaveLength(1);
    now = 31_000;
    await flags.getFeatureFlag("checkout");
    expect(calls).toHaveLength(2);
  });

  it("unknown flag returns the default and emits no exposure", async () => {
    const { flags, exposures } = makeFlagClient(() => OK({ other: true }));
    await expect(flags.getFeatureFlag("missing")).resolves.toBe(false);
    await expect(flags.getFeatureFlag("missing", { default: "fb" })).resolves.toBe("fb");
    expect(exposures).toHaveLength(0);
  });

  it("any failure returns the default, never throws", async () => {
    const { flags } = makeFlagClient(() => ({ status: 500, body: "" }));
    await expect(flags.getFeatureFlag("any", { default: true })).resolves.toBe(true);
    const malformed = makeFlagClient(() => ({ status: 200, body: "<<< not json" }));
    await expect(malformed.flags.isEnabled("any")).resolves.toBe(false);
  });

  it("does not retry /decide", async () => {
    const { flags, calls } = makeFlagClient(() => ({ status: 500, body: "" }));
    await flags.getFeatureFlag("any");
    expect(calls).toHaveLength(1);
  });

  it("personProperties bypasses the cache in both directions", async () => {
    const { flags, calls } = makeFlagClient(() => OK({ tier: true }));
    await flags.getFeatureFlag("tier");
    await flags.getFeatureFlag("tier", { personProperties: { plan: "pro" } });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body["person_properties"]).toEqual({ plan: "pro" });
    // the personProperties answer did not poison the cache
    await flags.getFeatureFlag("tier");
    expect(calls).toHaveLength(2);
  });

  it("isEnabled: true for true and non-empty variants, false otherwise", async () => {
    const { flags } = makeFlagClient(() => OK({ on: true, off: false, variant: "blue" }));
    await expect(flags.isEnabled("on")).resolves.toBe(true);
    await expect(flags.isEnabled("off")).resolves.toBe(false);
    await expect(flags.isEnabled("variant")).resolves.toBe(true);
    await expect(flags.isEnabled("missing")).resolves.toBe(false);
    await expect(flags.isEnabled("missing", { default: true })).resolves.toBe(true);
  });

  it("exposes once per flag value; invalidate() resets the dedup", async () => {
    const { flags, exposures } = makeFlagClient(() => OK({ exposed: true }));
    await flags.getFeatureFlag("exposed");
    await flags.getFeatureFlag("exposed");
    expect(exposures).toEqual([["exposed", true]]);
    flags.invalidate();
    await flags.getFeatureFlag("exposed");
    expect(exposures).toHaveLength(2);
  });

  it("sends write_key and distinct_id to /decide", async () => {
    const { flags, calls } = makeFlagClient(() => OK({}));
    await flags.getFeatureFlag("any");
    expect(calls[0]?.body).toEqual({ write_key: "wk_test_public", distinct_id: "user_42" });
  });
});
