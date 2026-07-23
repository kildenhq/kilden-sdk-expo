import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { KildenClient } from "../src/client.js";
import { K_SESSION, SESSION_TIMEOUT_MS, SessionManager } from "../src/session.js";
import { MemoryStorage } from "../src/storage.js";
import type { EventPayload, InitOptions, Transport, TransportResponse } from "../src/types.js";
import { UUID_V7_RE, sleep } from "./helpers.js";

const fill = (array: Uint8Array): Uint8Array => {
  randomFillSync(array);
  return array;
};

function makeTransport(): { transport: Transport; batches: EventPayload[][] } {
  const batches: EventPayload[][] = [];
  const transport: Transport = {
    async send(_url, body): Promise<TransportResponse> {
      batches.push((JSON.parse(body) as { batch: EventPayload[] }).batch);
      return { status: 200, headers: {}, body: "" };
    },
  };
  return { transport, batches };
}

function newClient(options: Partial<InitOptions> = {}, transport?: Transport): KildenClient {
  return new KildenClient("wk_test_public", {
    flushAt: 1000,
    flushIntervalMs: 0,
    storage: new MemoryStorage(),
    transport: transport ?? makeTransport().transport,
    context: () => ({}),
    getRandomValues: fill,
    trackAppLifecycle: false,
    ...options,
  });
}

describe("SessionManager", () => {
  function makeManager(now: () => number, storage = new MemoryStorage()) {
    const log = { debug() {}, warn() {} };
    return new SessionManager(storage, fill, log, now);
  }

  it("touch returns a stable UUID v7 while the session is active", () => {
    const manager = makeManager(() => 1_000_000);
    const first = manager.touch();
    expect(first).toMatch(UUID_V7_RE);
    expect(manager.touch()).toBe(first);
  });

  it("rotates the id after 30 minutes of inactivity", () => {
    let now = 1_000_000;
    const manager = makeManager(() => now);
    const first = manager.touch();
    now += SESSION_TIMEOUT_MS + 1;
    const second = manager.touch();
    expect(second).not.toBe(first);
    expect(second).toMatch(UUID_V7_RE);
  });

  it("activity within the window extends the session past the original deadline", () => {
    let now = 1_000_000;
    const manager = makeManager(() => now);
    const first = manager.touch();
    now += SESSION_TIMEOUT_MS - 1_000;
    expect(manager.touch()).toBe(first);
    now += SESSION_TIMEOUT_MS - 1_000;
    expect(manager.touch()).toBe(first);
  });

  it("hydrate restores a stored session that is still within the window", () => {
    const manager = makeManager(() => 1_000_000);
    manager.hydrate(JSON.stringify({ id: "0197a000-0000-7000-8000-000000000000", last: 999_000 }));
    expect(manager.touch()).toBe("0197a000-0000-7000-8000-000000000000");
  });

  it("hydrate ignores corrupt or malformed stored values", () => {
    const manager = makeManager(() => 1_000_000);
    manager.hydrate("not json{");
    expect(manager.touch()).toMatch(UUID_V7_RE);
    const other = makeManager(() => 1_000_000);
    other.hydrate(JSON.stringify({ id: 42, last: "yesterday" }));
    expect(other.touch()).toMatch(UUID_V7_RE);
  });
});

describe("client session integration", () => {
  it("every event carries $session_id and it is stable within the session", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    client.track("first");
    client.screen("Home");
    client.identify("user_42");
    await client.flush();

    const events = batches.flat();
    expect(events).toHaveLength(3);
    const ids = events.map((event) => event.properties["$session_id"]);
    expect(ids[0]).toMatch(UUID_V7_RE);
    expect(new Set(ids).size).toBe(1);
  });

  it("the session survives a restart with the same storage", async () => {
    const storage = new MemoryStorage();
    const { transport, batches } = makeTransport();
    const first = newClient({ storage }, transport);
    first.track("before_restart");
    await first.flush();
    await sleep(5); // coalesced session persist runs on a macrotask

    const second = newClient({ storage }, transport);
    second.track("after_restart");
    await second.flush();

    const events = batches.flat();
    expect(events[1]?.properties["$session_id"]).toBe(events[0]?.properties["$session_id"]);
    expect(await storage.getItem(K_SESSION)).toContain(String(events[0]?.properties["$session_id"]));
  });

  it("still stamps a session id when storage reads fail (degraded mode)", async () => {
    const storage = new MemoryStorage();
    storage.getItem = async () => {
      throw new Error("disk on fire");
    };
    const { transport, batches } = makeTransport();
    const client = newClient({ storage }, transport);
    client.track("degraded");
    await client.flush();

    expect(batches.flat()[0]?.properties["$session_id"]).toMatch(UUID_V7_RE);
  });

  it("an explicit user property cannot be clobbered by the session stamp", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    client.track("custom", { $session_id: "explicit-id" });
    await client.flush();

    expect(batches.flat()[0]?.properties["$session_id"]).toBe("explicit-id");
  });
});
