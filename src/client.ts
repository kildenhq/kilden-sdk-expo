import { Batcher } from "./batcher.js";
import { utf8ByteLength } from "./encoding.js";
import { installExceptionHandler } from "./exception.js";
import type { SessionRecordingConfig } from "./flags.js";
import { FlagClient } from "./flags.js";
import { TokenManager } from "./identity-token.js";
import type { Logger } from "./log.js";
import { makeLogger, silentLogger } from "./log.js";
import {
  defaultAppState,
  defaultContextProvider,
  defaultRandomFill,
  defaultStorage,
} from "./rn-defaults.js";
import { K_SESSION, SessionManager } from "./session.js";
import { K_ANON, K_DISTINCT, K_QUEUE, MemoryStorage } from "./storage.js";
import { formatTimestamp, normalizeTimestamp } from "./timestamp.js";
import { FetchTransport } from "./transport.js";
import type {
  AppStateAdapter,
  FlagOptions,
  FlagValue,
  IdentifyOptions,
  InitOptions,
  KeyValueStorage,
  Properties,
  RandomFill,
  TrackOptions,
} from "./types.js";
import type { EventPayload } from "./types.js";
import { isCanonicalUuid, newAnonymousId, uuidv7 } from "./uuid.js";

const DEFAULT_API_HOST = "https://ingest.kilden.io";
const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_DEADLINE_MS = 10_000;

const MAX_EVENT_BYTES = 200;
const MAX_DISTINCT_ID_BYTES = 512;

interface Stamped {
  uuid: string;
  timestamp: string;
}

/**
 * Kilden client SDK for Expo / React Native (docs/27 §8): public write key,
 * persisted identity, docs/10 semantics adapted to mobile. Transport and
 * payload follow kilden-sdk-spec; the trust-model contract is inverted —
 * this constructor rejects SECRET keys (a secret key inside an app bundle
 * is a credential leak, not a configuration).
 */
export class KildenClient {
  private readonly enabled: boolean;
  private readonly log: Logger;
  private readonly debugMode: boolean;
  private readonly flushAt: number;
  private readonly maxQueueSize: number;
  private readonly persistQueue: boolean;
  private persistScheduled = false;
  private readonly storage: KeyValueStorage;
  private readonly random: RandomFill;
  private readonly contextFn: () => Properties;
  private readonly tokens: TokenManager;
  private readonly batcher: Batcher;
  private readonly flagClient: FlagClient;
  private readonly sessions: SessionManager;
  private readonly hydration: Promise<void>;

  private anonId = "";
  private distinctId = "";
  private hydrated = false;
  private pending: Array<() => void> = [];
  private queue: EventPayload[] = [];
  private inflight: Promise<void> | null = null;
  private selfDropped = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeAppState: (() => void) | null = null;
  private uninstallExceptions: (() => void) | null = null;
  private appStateStatus = "active";

  constructor(writeKey: string, options: InitOptions = {}) {
    if (typeof writeKey !== "string" || writeKey.length === 0) {
      throw new Error("kilden: write key is required");
    }
    if (writeKey.startsWith("sk_")) {
      throw new Error(
        "kilden: this is a SECRET write key. A secret key shipped inside an app " +
          "bundle can be extracted by anyone — use the project's public write key " +
          "(wk_...) and keep sk_ keys on your backend.",
      );
    }

    this.enabled = options.enabled !== false;
    this.debugMode = options.debug === true;
    this.log = this.enabled ? makeLogger(this.debugMode) : silentLogger;
    this.flushAt = options.flushAt ?? DEFAULT_FLUSH_AT;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.persistQueue = options.persistQueue === true;

    const apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const transport = options.transport ?? new FetchTransport();

    this.storage = this.enabled
      ? (options.storage ?? defaultStorage(this.log))
      : new MemoryStorage();
    this.random = options.getRandomValues ?? defaultRandomFill(this.log);
    this.contextFn = options.context ?? defaultContextProvider();

    this.tokens = new TokenManager(options.getIdentityToken, this.log);
    if (options.identityToken) this.tokens.set(options.identityToken);
    this.sessions = new SessionManager(this.storage, this.random, this.log);

    this.batcher = new Batcher({
      url: `${apiHost}/capture`,
      writeKey,
      transport,
      timeoutMs,
      log: this.log,
      getToken: () => this.tokens.get(),
      onUnauthorized: () => this.tokens.handle401(),
    });

    this.flagClient = new FlagClient({
      url: `${apiHost}/decide`,
      writeKey,
      transport,
      timeoutMs,
      log: this.log,
      getDistinctId: () => this.getDistinctId(),
      onExposure: (flagKey, value) => {
        this.capture(
          "$feature_flag_called",
          {},
          undefined,
          { $flag_key: flagKey, $flag_value: value },
          true,
        );
      },
    });

    if (!this.enabled) {
      this.hydration = Promise.resolve();
      this.hydrated = true;
      return;
    }

    this.hydration = this.hydrate();

    const intervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (intervalMs > 0) {
      this.flushTimer = setInterval(() => void this.flush(), intervalMs);
      (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    }

    // Lifecycle events need a lifecycle source: without an AppState adapter
    // (plain Node, tests) nothing is emitted automatically.
    const trackLifecycle = options.trackAppLifecycle !== false;
    const appState: AppStateAdapter | null =
      options.appState !== undefined ? options.appState : defaultAppState();
    if (appState) {
      this.unsubscribeAppState = appState.addListener((state) => {
        const previous = this.appStateStatus;
        this.appStateStatus = state;
        if (state === "background" || state === "inactive") {
          if (trackLifecycle && previous === "active") {
            this.capture("$app_backgrounded", {}, undefined, {}, true);
          }
          // No sendBeacon in React Native — flushing when the app leaves the
          // foreground is the mobile replacement (docs/27 §8).
          void this.flush();
        } else if (state === "active" && previous !== "active" && trackLifecycle) {
          this.capture("$app_opened", {}, undefined, { $from_background: true }, true);
        }
      });
      if (trackLifecycle) {
        this.capture("$app_opened", {}, undefined, { $from_background: false }, true);
      }
    }

    if (options.captureExceptions === true) {
      this.uninstallExceptions = installExceptionHandler((detail) => {
        this.capture(
          "$exception",
          {},
          undefined,
          {
            $exception_type: detail.type,
            $exception_message: detail.message,
            $exception_fatal: detail.fatal,
            ...(detail.stack !== undefined ? { $exception_stack: detail.stack } : {}),
          },
          true,
        );
        // A fatal error usually means the process is about to die: get the
        // queue on the wire while there is still a runtime to do it.
        if (detail.fatal) void this.flush();
      }, this.log);
    }
  }

  track(event: string, properties?: Properties, options?: TrackOptions): void {
    this.safe(() => {
      if (this.dropIfInactive("track")) return;
      if (!this.validEventName(event)) return;
      if (event.startsWith("$")) {
        this.log.debug(`"${event}": the "$" prefix is reserved for Kilden system events`);
      }
      const props = this.snapshot(properties);
      if (props === null) {
        this.dropWithWarning(`track "${event}": properties are not JSON-serializable`);
        return;
      }
      this.warnDollarKeys(props);
      const stamped = this.stamp(options);
      if (!stamped) return;
      this.enqueueOp(() => this.emit(event, props, stamped));
    });
  }

  /** Records a screen view as a $screen event with $screen_name. */
  screen(name: string, properties?: Properties, options?: TrackOptions): void {
    this.safe(() => {
      if (this.dropIfInactive("screen")) return;
      if (typeof name !== "string" || name.length === 0) {
        this.dropWithWarning("screen: name must be a non-empty string");
        return;
      }
      const props = this.snapshot(properties);
      if (props === null) {
        this.dropWithWarning(`screen "${name}": properties are not JSON-serializable`);
        return;
      }
      const stamped = this.stamp(options);
      if (!stamped) return;
      this.enqueueOp(() => this.emit("$screen", props, stamped, { $screen_name: name }));
    });
  }

  identify(distinctId: string, traits?: Properties, options?: IdentifyOptions): void {
    this.safe(() => {
      if (this.dropIfInactive("identify")) return;
      if (options?.token !== undefined) this.tokens.set(options.token);
      if (!this.validDistinctId(distinctId, "identify")) return;
      const snapshotted = this.snapshot(traits);
      if (snapshotted === null) {
        this.dropWithWarning("identify: traits are not JSON-serializable");
        return;
      }
      const stamped = this.stamp();
      if (!stamped) return;
      this.enqueueOp(() => {
        if (distinctId === this.distinctId) {
          // Already identified as this user: treat traits as a plain $set.
          if (Object.keys(snapshotted).length > 0) {
            this.emit("$set", {}, stamped, { $set: snapshotted });
          }
          return;
        }
        const previousId = this.distinctId;
        this.distinctId = distinctId;
        this.persist(K_DISTINCT, distinctId);
        this.emit("$identify", {}, stamped, {
          $anon_distinct_id: previousId,
          $set: snapshotted,
        });
        this.flagClient.invalidate();
      });
    });
  }

  /**
   * Links another id to the CURRENT identity: emits $alias with the current
   * distinct_id as the envelope id and the new id under properties.$alias
   * (the frozen $alias shape from kilden-sdk-spec §4.6). Local identity
   * state does not change.
   */
  alias(aliasId: string): void {
    this.safe(() => {
      if (this.dropIfInactive("alias")) return;
      if (!this.validDistinctId(aliasId, "alias")) return;
      const stamped = this.stamp();
      if (!stamped) return;
      this.enqueueOp(() => this.emit("$alias", {}, stamped, { $alias: aliasId }));
    });
  }

  /** Logs out: fresh anonymous identity, identity token cleared, flag cache dropped. */
  reset(): void {
    this.safe(() => {
      if (this.dropIfInactive("reset")) return;
      this.enqueueOp(() => {
        this.anonId = newAnonymousId(this.random);
        this.distinctId = this.anonId;
        this.persist(K_ANON, this.anonId);
        this.persist(K_DISTINCT, this.distinctId);
        this.tokens.set(null);
        this.flagClient.invalidate();
      });
    });
  }

  /** Current distinct_id (async: waits for storage hydration). */
  async getDistinctId(): Promise<string> {
    await this.hydration;
    return this.distinctId;
  }

  setIdentityToken(token: string | null): void {
    this.safe(() => this.tokens.set(token));
  }

  async getFeatureFlag(flagKey: string, options?: FlagOptions): Promise<FlagValue> {
    if (!this.enabled || this.closed) return options?.default ?? false;
    return this.flagClient.getFeatureFlag(flagKey, options);
  }

  async isFeatureEnabled(flagKey: string, options?: FlagOptions): Promise<boolean> {
    if (!this.enabled || this.closed) return options?.default === true;
    return this.flagClient.isEnabled(flagKey, options);
  }

  /**
   * Project session-recording config from the last /decide answer, or null
   * before one lands. Deliberate wiring for mobile replay (docs/todos
   * expo-1 fase 2): nothing records today — this is the future kill-switch.
   */
  getSessionRecordingConfig(): SessionRecordingConfig | null {
    return this.flagClient.getSessionRecordingConfig();
  }

  /** Drains everything queued right now, including retries. Never rejects. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    await this.hydration;
    // The null reset lives in .finally() — a microtask that always runs AFTER
    // this assignment. Resetting inside the drain itself breaks when the queue
    // is empty: the drain completes synchronously, its reset runs before ??=
    // assigns, and the stale resolved promise blocks every future flush.
    this.inflight ??= this.drain()
      .catch(() => {
        // batcher never throws; belt and suspenders for contract 1
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0);
      await this.batcher.send(batch);
      this.schedulePersist();
    }
  }

  /**
   * Final flush with a 10s deadline, then the client goes inert. Idempotent;
   * events captured after close are dropped with a warning.
   */
  async close(): Promise<void> {
    if (!this.enabled) return;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.flushTimer !== null) clearInterval(this.flushTimer);
      this.unsubscribeAppState?.();
      this.uninstallExceptions?.();
      this.tokens.stop();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), CLOSE_DEADLINE_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      const result = await Promise.race([this.flush().then(() => "done" as const), deadline]);
      if (timer !== null) clearTimeout(timer);
      this.closed = true;
      if (result === "deadline" && this.queue.length > 0) {
        if (this.persistQueue) {
          // Undrained but already on disk (write-through at enqueue): do NOT
          // persist the emptied queue or we would wipe them; the next launch
          // restores and delivers them.
          this.log.warn(
            `close: deadline reached with ${this.queue.length} event(s) left persisted`,
          );
        } else {
          this.selfDropped += this.queue.length;
          this.log.warn(`close: deadline reached with ${this.queue.length} event(s) undrained`);
        }
        this.queue = [];
      } else {
        this.schedulePersist();
      }
    })();
    return this.closing;
  }

  /** Events dropped so far (invalid input, full queue, delivery failures). */
  get dropped(): number {
    return this.selfDropped + this.batcher.dropped;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async hydrate(): Promise<void> {
    try {
      const [anon, distinct, persisted, session] = await Promise.all([
        this.storage.getItem(K_ANON),
        this.storage.getItem(K_DISTINCT),
        this.persistQueue ? this.storage.getItem(K_QUEUE) : Promise.resolve(null),
        this.storage.getItem(K_SESSION),
      ]);
      this.sessions.hydrate(session);
      if (persisted) this.restoreQueue(persisted);
      if (anon) {
        this.anonId = anon;
      } else {
        this.anonId = newAnonymousId(this.random);
        this.persist(K_ANON, this.anonId);
      }
      this.distinctId = distinct || this.anonId;
    } catch {
      this.log.warn("storage read failed; starting with a fresh in-memory identity");
      this.anonId = this.anonId || newAnonymousId(this.random);
      this.distinctId = this.distinctId || this.anonId;
    }
    this.hydrated = true;
    const ops = this.pending.splice(0);
    for (const op of ops) op();
    if (this.queue.length >= this.flushAt) void this.flush();
  }

  /** Events persisted by a previous process (the OS killed the app mid-queue). */
  private restoreQueue(persisted: string): void {
    try {
      const events = JSON.parse(persisted) as unknown;
      if (!Array.isArray(events)) return;
      for (const event of events as EventPayload[]) {
        if (
          event !== null &&
          typeof event === "object" &&
          typeof event.uuid === "string" &&
          typeof event.event === "string" &&
          typeof event.distinct_id === "string" &&
          typeof event.timestamp === "string" &&
          event.properties !== null &&
          typeof event.properties === "object" &&
          this.queue.length < this.maxQueueSize
        ) {
          this.queue.push(event);
        }
      }
      if (this.queue.length > 0) {
        this.log.debug(`restored ${this.queue.length} persisted event(s)`);
      }
    } catch {
      this.log.warn("persisted queue was unreadable; discarding it");
    }
    this.schedulePersist();
  }

  /**
   * Coalesced write-through of the queue (persistQueue: true). Runs after
   * every enqueue and after every delivered batch, so on the next launch the
   * disk holds exactly the undelivered events. A batch in flight when the OS
   * kills the app is re-sent on restore — at-least-once, deduped by uuid.
   */
  private schedulePersist(): void {
    if (!this.persistQueue || this.persistScheduled) return;
    this.persistScheduled = true;
    const timer = setTimeout(() => {
      this.persistScheduled = false;
      let serialized: string;
      try {
        serialized = JSON.stringify(this.queue);
      } catch {
        return;
      }
      void this.storage.setItem(K_QUEUE, serialized).catch(() => {
        this.log.debug("storage write failed for the persisted queue");
      });
    }, 0);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Internal capture used by the flag exposure pipeline. */
  private capture(
    event: string,
    properties: Properties,
    options: TrackOptions | undefined,
    systemProperties: Properties,
    internal: boolean,
  ): void {
    this.safe(() => {
      if (this.closed || !this.enabled) return;
      if (!internal && !this.validEventName(event)) return;
      const stamped = this.stamp(options);
      if (!stamped) return;
      this.enqueueOp(() => this.emit(event, properties, stamped, systemProperties));
    });
  }

  private emit(
    event: string,
    userProperties: Properties,
    stamped: Stamped,
    systemProperties: Properties = {},
  ): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.selfDropped += 1;
      this.log.warn(`queue full (${this.maxQueueSize}); dropping "${event}"`);
      return;
    }
    let context: Properties = {};
    try {
      context = this.contextFn() ?? {};
    } catch {
      context = {};
    }
    this.queue.push({
      uuid: stamped.uuid,
      event,
      distinct_id: this.distinctId,
      properties: {
        ...context,
        $session_id: this.sessions.touch(),
        ...systemProperties,
        ...userProperties,
      },
      timestamp: stamped.timestamp,
    });
    this.schedulePersist();
    if (this.queue.length >= this.flushAt) void this.flush();
  }

  private enqueueOp(op: () => void): void {
    if (this.hydrated) {
      op();
    } else {
      this.pending.push(op);
    }
  }

  private stamp(options?: TrackOptions): Stamped | null {
    let uuid: string;
    if (options?.uuid !== undefined) {
      if (typeof options.uuid !== "string" || !isCanonicalUuid(options.uuid)) {
        this.dropWithWarning(`invalid explicit uuid "${String(options.uuid)}"`);
        return null;
      }
      uuid = options.uuid;
    } else {
      uuid = uuidv7(this.random);
    }
    let timestamp: string;
    if (options?.timestamp !== undefined) {
      const normalized = normalizeTimestamp(options.timestamp);
      if (normalized === null) {
        this.dropWithWarning("uninterpretable explicit timestamp");
        return null;
      }
      timestamp = normalized;
    } else {
      timestamp = formatTimestamp();
    }
    return { uuid, timestamp };
  }

  /** JSON snapshot at call time; null when not serializable (event is dropped). */
  private snapshot(properties?: Properties): Properties | null {
    if (properties === undefined || properties === null) return {};
    if (typeof properties !== "object" || Array.isArray(properties)) return null;
    try {
      return JSON.parse(JSON.stringify(properties)) as Properties;
    } catch {
      return null;
    }
  }

  private validEventName(event: string): boolean {
    if (typeof event !== "string" || event.length === 0) {
      this.dropWithWarning("event name must be a non-empty string");
      return false;
    }
    if (utf8ByteLength(event) > MAX_EVENT_BYTES) {
      this.dropWithWarning(`event name exceeds ${MAX_EVENT_BYTES} bytes`);
      return false;
    }
    return true;
  }

  private validDistinctId(value: string, method: string): boolean {
    if (typeof value !== "string" || value.length === 0) {
      this.dropWithWarning(`${method}: distinct_id must be a non-empty string`);
      return false;
    }
    if (utf8ByteLength(value) > MAX_DISTINCT_ID_BYTES) {
      this.dropWithWarning(`${method}: distinct_id exceeds ${MAX_DISTINCT_ID_BYTES} bytes`);
      return false;
    }
    return true;
  }

  private warnDollarKeys(properties: Properties): void {
    if (!this.debugMode) return;
    for (const key of Object.keys(properties)) {
      if (key.startsWith("$")) {
        this.log.debug(`property "${key}": the "$" prefix is reserved for Kilden`);
      }
    }
  }

  private dropIfInactive(method: string): boolean {
    if (!this.enabled) return true;
    if (this.closed) {
      this.selfDropped += 1;
      this.log.warn(`${method}: client is closed; event dropped`);
      return true;
    }
    return false;
  }

  private dropWithWarning(message: string): void {
    this.selfDropped += 1;
    this.log.warn(message);
  }

  private persist(key: string, value: string): void {
    void this.storage.setItem(key, value).catch(() => {
      this.log.debug(`storage write failed for ${key}`);
    });
  }

  /** Contract 1: the public API never throws after construction. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      try {
        this.log.warn(`internal error: ${String(error)}`);
      } catch {
        // even logging must not throw
      }
    }
  }
}
