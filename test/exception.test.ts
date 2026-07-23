import { randomFillSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { KildenClient } from "../src/client.js";
import { scrubExceptionMessage } from "../src/exception.js";
import { MemoryStorage } from "../src/storage.js";
import type { EventPayload, InitOptions, Transport, TransportResponse } from "../src/types.js";

const fill = (array: Uint8Array): Uint8Array => {
  randomFillSync(array);
  return array;
};

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface FakeErrorUtils {
  getGlobalHandler(): GlobalErrorHandler | null;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}

function installFakeErrorUtils(): {
  utils: FakeErrorUtils;
  fire: (error: unknown, isFatal?: boolean) => void;
  current: () => GlobalErrorHandler | null;
} {
  let handler: GlobalErrorHandler | null = null;
  const utils: FakeErrorUtils = {
    getGlobalHandler: () => handler,
    setGlobalHandler(next) {
      handler = next;
    },
  };
  (globalThis as { ErrorUtils?: FakeErrorUtils }).ErrorUtils = utils;
  return {
    utils,
    fire(error, isFatal) {
      handler?.(error, isFatal);
    },
    current: () => handler,
  };
}

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

afterEach(() => {
  delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
});

describe("scrubExceptionMessage", () => {
  it("redacts email addresses", () => {
    expect(scrubExceptionMessage("login failed for ana@example.com!")).toBe(
      "login failed for [email]!",
    );
  });

  it("redacts long digit runs (ids, phones, cards) but keeps short numbers", () => {
    expect(scrubExceptionMessage("card 4111111111111111 declined at row 42")).toBe(
      "card [digits] declined at row 42",
    );
  });

  it("truncates messages beyond 1000 characters", () => {
    const scrubbed = scrubExceptionMessage("x".repeat(2000));
    expect(scrubbed.length).toBeLessThanOrEqual(1000);
  });
});

describe("captureExceptions", () => {
  it("is off by default: no handler is installed", () => {
    const fake = installFakeErrorUtils();
    newClient();
    expect(fake.current()).toBeNull();
  });

  it("captures $exception with type, scrubbed message and fatal flag", async () => {
    const fake = installFakeErrorUtils();
    const { transport, batches } = makeTransport();
    const client = newClient({ captureExceptions: true }, transport);

    const error = new TypeError("cannot read email ana@example.com of undefined");
    fake.fire(error, false);
    await client.flush();

    const event = batches.flat().find((payload) => payload.event === "$exception");
    expect(event).toBeDefined();
    expect(event?.properties["$exception_type"]).toBe("TypeError");
    expect(event?.properties["$exception_message"]).toBe(
      "cannot read email [email] of undefined",
    );
    expect(event?.properties["$exception_fatal"]).toBe(false);
    expect(event?.properties["$session_id"]).toBeTruthy();
  });

  it("chains to the previously installed global handler", () => {
    const fake = installFakeErrorUtils();
    const seen: unknown[] = [];
    fake.utils.setGlobalHandler((error) => seen.push(error));
    newClient({ captureExceptions: true });

    const error = new Error("boom");
    fake.fire(error, true);
    expect(seen).toEqual([error]);
  });

  it("handles non-Error throwables without crashing", async () => {
    const fake = installFakeErrorUtils();
    const { transport, batches } = makeTransport();
    const client = newClient({ captureExceptions: true }, transport);

    fake.fire("just a string", undefined);
    await client.flush();

    const event = batches.flat().find((payload) => payload.event === "$exception");
    expect(event?.properties["$exception_type"]).toBe("Error");
    expect(event?.properties["$exception_message"]).toBe("just a string");
  });

  it("close() uninstalls the handler and restores the previous one", async () => {
    const fake = installFakeErrorUtils();
    const previous: GlobalErrorHandler = () => {};
    fake.utils.setGlobalHandler(previous);
    const client = newClient({ captureExceptions: true });
    expect(fake.current()).not.toBe(previous);
    await client.close();
    expect(fake.current()).toBe(previous);
  });
});
