import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { KildenClient } from "../src/client.js";
import { K_ANON, K_DISTINCT, K_QUEUE, MemoryStorage } from "../src/storage.js";
import type {
  EventPayload,
  InitOptions,
  Transport,
  TransportResponse,
} from "../src/types.js";

const fill = (array: Uint8Array): Uint8Array => {
  randomFillSync(array);
  return array;
};

function makeTransport(status = 200): { transport: Transport; batches: EventPayload[][] } {
  const batches: EventPayload[][] = [];
  const transport: Transport = {
    async send(_url, body): Promise<TransportResponse> {
      batches.push((JSON.parse(body) as { batch: EventPayload[] }).batch);
      return { status, headers: {}, body: "" };
    },
  };
  return { transport, batches };
}

function newClient(
  options: Partial<InitOptions> = {},
  transport?: Transport,
): KildenClient {
  return new KildenClient("wk_test_public", {
    flushAt: 1000,
    flushIntervalMs: 0,
    storage: new MemoryStorage(),
    transport: transport ?? makeTransport().transport,
    context: () => ({}),
    getRandomValues: fill,
    ...options,
  });
}

describe("constructor", () => {
  it("rejects secret keys with a teaching message", () => {
    expect(() => new KildenClient("sk_live_abc")).toThrow(/secret/i);
  });

  it("rejects an empty write key", () => {
    expect(() => new KildenClient("")).toThrow();
  });

  it("accepts the public wk_ key", () => {
    expect(() => newClient()).not.toThrow();
  });
});

describe("identity", () => {
  it("generates and persists an anon_ id on first run", async () => {
    const storage = new MemoryStorage();
    const client = newClient({ storage });
    const distinctId = await client.getDistinctId();
    expect(distinctId).toMatch(/^anon_/);
    expect(await storage.getItem(K_ANON)).toBe(distinctId);
  });

  it("identity survives a restart with the same storage", async () => {
    const storage = new MemoryStorage();
    const first = newClient({ storage });
    first.identify("user_42");
    await first.flush();

    const second = newClient({ storage });
    expect(await second.getDistinctId()).toBe("user_42");
  });

  it("identify emits $identify with $anon_distinct_id and $set, and switches ids", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    const anonId = await client.getDistinctId();
    client.identify("user_42", { plan: "pro" });
    client.track("after_identify");
    await client.flush();

    const events = batches.flat();
    expect(events[0]?.event).toBe("$identify");
    expect(events[0]?.distinct_id).toBe("user_42");
    expect(events[0]?.properties).toEqual({
      $anon_distinct_id: anonId,
      $set: { plan: "pro" },
    });
    expect(events[1]?.distinct_id).toBe("user_42");
  });

  it("identify with the current id becomes a $set (no re-identify)", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    client.identify("user_42");
    client.identify("user_42", { plan: "pro" });
    await client.flush();

    const events = batches.flat();
    const kinds = events.map((event) => event.event);
    expect(kinds.filter((kind) => kind === "$identify")).toHaveLength(1);
    const set = events.find((event) => event.event === "$set");
    expect(set?.properties).toEqual({ $set: { plan: "pro" } });
  });

  it("alias emits the frozen shape from the CURRENT identity and keeps state", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    client.identify("user_42");
    client.alias("legacy_id_7");
    await client.flush();

    const aliasEvent = batches.flat().find((event) => event.event === "$alias");
    expect(aliasEvent?.distinct_id).toBe("user_42");
    expect(aliasEvent?.properties).toEqual({ $alias: "legacy_id_7" });
    expect(await client.getDistinctId()).toBe("user_42");
  });

  it("reset rotates to a fresh anonymous identity", async () => {
    const storage = new MemoryStorage();
    const client = newClient({ storage });
    client.identify("user_42");
    client.reset();
    const distinctId = await client.getDistinctId();
    expect(distinctId).toMatch(/^anon_/);
    expect(await storage.getItem(K_DISTINCT)).toBe(distinctId);
  });

  it("calls made before hydration resolve in order with the stored identity", async () => {
    const storage = new MemoryStorage();
    await storage.setItem(K_ANON, "anon_stored");
    await storage.setItem(K_DISTINCT, "user_stored");
    const { transport, batches } = makeTransport();
    const client = newClient({ storage }, transport);
    client.track("immediate"); // before hydration resolves
    await client.flush();
    expect(batches.flat()[0]?.distinct_id).toBe("user_stored");
  });
});

describe("events", () => {
  it("screen emits $screen with $screen_name; explicit properties win over system ones", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    client.screen("Checkout", { step: 2 });
    await client.flush();
    const event = batches.flat()[0];
    expect(event?.event).toBe("$screen");
    expect(event?.properties).toEqual({ $screen_name: "Checkout", step: 2 });
  });

  it("merges context properties, explicit properties win", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient(
      { context: () => ({ $lib: "kilden-expo", $os: "ios" }) },
      transport,
    );
    client.track("themed", { $os: "custom" });
    await client.flush();
    expect(batches.flat()[0]?.properties).toEqual({ $lib: "kilden-expo", $os: "custom" });
  });

  it("drops invalid input without throwing and counts it", async () => {
    const client = newClient();
    client.track("");
    client.track("x".repeat(201));
    client.identify("");
    client.alias("");
    client.screen("");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    client.track("circular", circular as never);
    expect(client.dropped).toBe(6);
  });

  it("snapshots properties at call time", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    const properties = { plan: "pro" };
    client.track("snap", properties);
    properties.plan = "mutated";
    await client.flush();
    expect(batches.flat()[0]?.properties["plan"]).toBe("pro");
  });

  it("drops the NEW event when the queue is full", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({ maxQueueSize: 2, flushAt: 1000 }, transport);
    await client.getDistinctId(); // hydrated so events enqueue immediately
    client.track("kept_1");
    client.track("kept_2");
    client.track("dropped_3");
    await client.flush();
    const names = batches.flat().map((event) => event.event);
    expect(names).toEqual(["kept_1", "kept_2"]);
    expect(client.dropped).toBe(1);
  });

  it("flushes at flushAt", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({ flushAt: 2 }, transport);
    await client.getDistinctId();
    client.track("one");
    client.track("two");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(batches.flat()).toHaveLength(2);
    await client.close();
  });

  it("enabled:false is a full no-op", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({ enabled: false }, transport);
    client.track("nope");
    await client.flush();
    await client.close();
    expect(batches).toHaveLength(0);
    expect(client.dropped).toBe(0);
  });
});

describe("persistQueue", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("events survive a simulated app kill and deliver on the next launch", async () => {
    const storage = new MemoryStorage();
    const first = newClient({ storage, persistQueue: true });
    first.track("queued_1");
    first.track("queued_2", { n: 2 });
    await first.getDistinctId(); // hydrated
    await tick(); // coalesced persist flushes to storage
    // no close(): the OS killed the app

    const { transport, batches } = makeTransport();
    const second = newClient({ storage, persistQueue: true }, transport);
    await second.flush();
    const events = batches.flat();
    expect(events.map((event) => event.event)).toEqual(["queued_1", "queued_2"]);
    expect(events[1]?.properties["n"]).toBe(2);
  });

  it("restored events keep their original uuid (idempotent re-send)", async () => {
    const storage = new MemoryStorage();
    const first = newClient({ storage, persistQueue: true });
    first.track("kept_uuid");
    await first.getDistinctId();
    await tick();
    const persisted = JSON.parse((await storage.getItem(K_QUEUE)) as string) as Array<{
      uuid: string;
    }>;

    const { transport, batches } = makeTransport();
    const second = newClient({ storage, persistQueue: true }, transport);
    await second.flush();
    expect(batches.flat()[0]?.uuid).toBe(persisted[0]?.uuid);
  });

  it("delivered events are removed from disk", async () => {
    const storage = new MemoryStorage();
    const { transport } = makeTransport();
    const client = newClient({ storage, persistQueue: true }, transport);
    client.track("delivered");
    await client.flush();
    await tick();
    expect(await storage.getItem(K_QUEUE)).toBe("[]");
  });

  it("an unreadable persisted queue is discarded without throwing", async () => {
    const storage = new MemoryStorage();
    await storage.setItem(K_QUEUE, "<<< not json");
    const { transport, batches } = makeTransport();
    const client = newClient({ storage, persistQueue: true }, transport);
    client.track("fresh");
    await client.flush();
    expect(batches.flat().map((event) => event.event)).toEqual(["fresh"]);
  });

  it("is off by default: nothing is written under kilden_queue", async () => {
    const storage = new MemoryStorage();
    const client = newClient({ storage });
    client.track("ephemeral");
    await client.getDistinctId();
    await tick();
    expect(await storage.getItem(K_QUEUE)).toBeNull();
  });
});

describe("lifecycle", () => {
  it("close is idempotent and drops later events with a count", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({}, transport);
    client.track("before_close");
    await client.close();
    await client.close();
    client.track("after_close");
    expect(batches.flat().map((event) => event.event)).toEqual(["before_close"]);
    expect(client.dropped).toBe(1);
  });

  it("flushes when the app goes to background", async () => {
    const { transport, batches } = makeTransport();
    let listener: ((state: string) => void) | null = null;
    const client = newClient(
      {
        appState: {
          addListener(callback) {
            listener = callback;
            return () => {
              listener = null;
            };
          },
        },
      },
      transport,
    );
    await client.getDistinctId();
    client.track("bg_flush");
    expect(batches).toHaveLength(0);
    (listener as unknown as (state: string) => void)("background");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(batches.flat().map((event) => event.event)).toEqual(["bg_flush"]);
    await client.close();
  });
});
