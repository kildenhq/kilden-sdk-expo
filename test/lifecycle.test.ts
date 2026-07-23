import { randomFillSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { KildenClient } from "../src/client.js";
import { attachNavigationTracking } from "../src/navigation.js";
import { MemoryStorage } from "../src/storage.js";
import type {
  AppStateAdapter,
  EventPayload,
  InitOptions,
  Transport,
  TransportResponse,
} from "../src/types.js";

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

function makeAppState(): { adapter: AppStateAdapter; fire: (state: string) => void } {
  const listeners: Array<(state: string) => void> = [];
  return {
    adapter: {
      addListener(callback) {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    },
    fire(state) {
      for (const listener of [...listeners]) listener(state);
    },
  };
}

function newClient(options: Partial<InitOptions> = {}, transport?: Transport): KildenClient {
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

describe("app lifecycle events", () => {
  it("emits $app_opened on cold start by default", async () => {
    const { transport, batches } = makeTransport();
    const { adapter } = makeAppState();
    const client = newClient({ appState: adapter }, transport);
    await client.flush();

    const events = batches.flat();
    expect(events.map((event) => event.event)).toContain("$app_opened");
    const opened = events.find((event) => event.event === "$app_opened");
    expect(opened?.properties["$from_background"]).toBe(false);
  });

  it("emits $app_backgrounded and then $app_opened on the round trip", async () => {
    const { transport, batches } = makeTransport();
    const { adapter, fire } = makeAppState();
    const client = newClient({ appState: adapter }, transport);
    fire("background");
    fire("active");
    await client.flush();

    const kinds = batches.flat().map((event) => event.event);
    expect(kinds).toEqual(["$app_opened", "$app_backgrounded", "$app_opened"]);
    const reopened = batches.flat().at(-1);
    expect(reopened?.properties["$from_background"]).toBe(true);
  });

  it("does not emit $app_backgrounded twice for inactive followed by background", async () => {
    const { transport, batches } = makeTransport();
    const { adapter, fire } = makeAppState();
    const client = newClient({ appState: adapter }, transport);
    fire("inactive");
    fire("background");
    await client.flush();

    const kinds = batches.flat().map((event) => event.event);
    expect(kinds.filter((kind) => kind === "$app_backgrounded")).toHaveLength(1);
  });

  it("trackAppLifecycle: false disables the automatic events", async () => {
    const { transport, batches } = makeTransport();
    const { adapter, fire } = makeAppState();
    const client = newClient({ appState: adapter, trackAppLifecycle: false }, transport);
    fire("background");
    fire("active");
    client.track("manual");
    await client.flush();

    const kinds = batches.flat().map((event) => event.event);
    expect(kinds).toEqual(["manual"]);
  });
});

describe("attachNavigationTracking", () => {
  interface FakeRoute {
    name?: string;
  }

  function makeNavigation(initial?: FakeRoute) {
    let route: FakeRoute | undefined = initial;
    const listeners: Array<() => void> = [];
    return {
      ref: {
        addListener(type: string, callback: () => void) {
          if (type === "state") listeners.push(callback);
          return () => {
            const index = listeners.indexOf(callback);
            if (index >= 0) listeners.splice(index, 1);
          };
        },
        getCurrentRoute() {
          return route;
        },
      },
      navigate(next: FakeRoute) {
        route = next;
        for (const listener of [...listeners]) listener();
      },
      listeners,
    };
  }

  it("tracks the initial route and every distinct navigation as $screen", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({ trackAppLifecycle: false }, transport);
    const navigation = makeNavigation({ name: "Home" });

    attachNavigationTracking(navigation.ref, client);
    navigation.navigate({ name: "Profile" });
    navigation.navigate({ name: "Profile" }); // same route: no duplicate
    navigation.navigate({ name: "Settings" });
    await client.flush();

    const screens = batches
      .flat()
      .filter((event) => event.event === "$screen")
      .map((event) => event.properties["$screen_name"]);
    expect(screens).toEqual(["Home", "Profile", "Settings"]);
  });

  it("returns an unsubscribe that stops tracking", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({ trackAppLifecycle: false }, transport);
    const navigation = makeNavigation({ name: "Home" });

    const detach = attachNavigationTracking(navigation.ref, client);
    detach();
    navigation.navigate({ name: "Profile" });
    await client.flush();

    const screens = batches.flat().filter((event) => event.event === "$screen");
    expect(screens.map((event) => event.properties["$screen_name"])).toEqual(["Home"]);
    expect(navigation.listeners).toHaveLength(0);
  });

  it("survives a ref without getCurrentRoute and routes without a name", async () => {
    const { transport, batches } = makeTransport();
    const client = newClient({ trackAppLifecycle: false }, transport);
    const navigation = makeNavigation(undefined);

    expect(() => attachNavigationTracking(navigation.ref, client)).not.toThrow();
    navigation.navigate({});
    navigation.navigate({ name: "Real" });
    await client.flush();

    const screens = batches.flat().filter((event) => event.event === "$screen");
    expect(screens.map((event) => event.properties["$screen_name"])).toEqual(["Real"]);
  });
});
