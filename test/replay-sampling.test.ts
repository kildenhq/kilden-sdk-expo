import { describe, expect, it } from "vitest";

import { decideSampling, K_REPLAY_SAMPLE } from "../src/replay/sampling.js";
import { MemoryStorage } from "../src/storage.js";

// SPEC-mobile §6.2: web semantics verbatim — one roll per session against
// mobile.sampleRate, persisted next to the session id, sticky for the
// session's life, re-rolled naturally when the session rotates.

describe("replay sampling", () => {
  it("rolls once and persists the decision for the session", async () => {
    const storage = new MemoryStorage();
    const sampled = await decideSampling(storage, "s1", 0.5, () => 0.4);
    expect(sampled).toBe(true);
    expect(JSON.parse((await storage.getItem(K_REPLAY_SAMPLE))!)).toEqual({
      sid: "s1",
      sampled: true,
    });
  });

  it("is sticky: a stored decision for the session is never re-rolled", async () => {
    const storage = new MemoryStorage();
    await decideSampling(storage, "s1", 1, () => 0.99); // sampled=true stored
    // Same session, rate now 0 and an rng that would say no: sticky wins.
    expect(await decideSampling(storage, "s1", 0, () => 0.99)).toBe(true);
  });

  it("re-rolls when the session rotates", async () => {
    const storage = new MemoryStorage();
    await decideSampling(storage, "s1", 1, () => 0.99);
    expect(await decideSampling(storage, "s2", 0, () => 0.99)).toBe(false);
    expect(JSON.parse((await storage.getItem(K_REPLAY_SAMPLE))!)).toEqual({
      sid: "s2",
      sampled: false,
    });
  });

  it("clamps the rate to [0, 1]", async () => {
    const storage = new MemoryStorage();
    expect(await decideSampling(storage, "s1", 7, () => 0.999)).toBe(true);
    expect(await decideSampling(storage, "s2", -1, () => 0)).toBe(false);
  });

  it("degrades to an in-memory decision when storage fails", async () => {
    const broken = {
      getItem: async () => {
        throw new Error("no storage");
      },
      setItem: async () => {
        throw new Error("no storage");
      },
      removeItem: async () => {},
    };
    expect(await decideSampling(broken, "s1", 1, () => 0.5)).toBe(true);
  });
});
