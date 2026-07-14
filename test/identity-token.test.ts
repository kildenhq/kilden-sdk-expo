import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenManager, parseExpMs } from "../src/identity-token.js";
import { silentLogger } from "../src/log.js";

function jwtWithExp(expSeconds: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: expSeconds, sub: "u" })}.sig`;
}

describe("parseExpMs", () => {
  it("extracts exp in ms", () => {
    expect(parseExpMs(jwtWithExp(1_730_003_600))).toBe(1_730_003_600_000);
  });

  it("returns null for malformed tokens", () => {
    expect(parseExpMs("not a jwt")).toBeNull();
    expect(parseExpMs("a.b.c")).toBeNull();
  });
});

describe("TokenManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes 60s before expiry when a refresher is configured", async () => {
    vi.setSystemTime(new Date("2026-07-14T12:00:00Z"));
    const expSeconds = Math.floor(Date.now() / 1000) + 300; // 5 min out
    let calls = 0;
    const manager = new TokenManager(async () => {
      calls += 1;
      return jwtWithExp(expSeconds + 3600);
    }, silentLogger);
    manager.set(jwtWithExp(expSeconds));

    await vi.advanceTimersByTimeAsync(239_000); // just before exp - 60s
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(1);
    expect(parseExpMs(manager.get() as string)).toBe((expSeconds + 3600) * 1000);
    manager.stop();
  });

  it("handle401 refreshes once and reports whether the token changed", async () => {
    let next = "fresh.token";
    const manager = new TokenManager(async () => next, silentLogger);
    manager.set("stale.token");
    await expect(manager.handle401()).resolves.toBe(true);
    expect(manager.get()).toBe("fresh.token");
    // same token again → not worth retrying
    next = "fresh.token";
    await expect(manager.handle401()).resolves.toBe(false);
  });

  it("handle401 is false without a refresher", async () => {
    const manager = new TokenManager(undefined, silentLogger);
    manager.set("anything");
    await expect(manager.handle401()).resolves.toBe(false);
  });

  it("a failing refresher never throws", async () => {
    const manager = new TokenManager(async () => {
      throw new Error("backend down");
    }, silentLogger);
    manager.set("stale");
    await expect(manager.handle401()).resolves.toBe(false);
  });
});
