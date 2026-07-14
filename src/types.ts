export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Properties = Record<string, JsonValue>;

/** One event as it goes on the wire (kilden-sdk-spec §4.1). */
export interface EventPayload {
  uuid: string;
  event: string;
  distinct_id: string;
  properties: Properties;
  timestamp: string;
}

export interface TrackOptions {
  /** Explicit event time; converted to ISO 8601 UTC with millisecond precision. */
  timestamp?: Date | string;
  /** Explicit event UUID (any canonical RFC 4122 form) for retry idempotency. */
  uuid?: string;
}

export interface IdentifyOptions {
  /** Identity token (JWT minted by your backend) to attach from this call on. */
  token?: string;
}

export type FlagValue = boolean | string;

export interface FlagOptions {
  /** Person properties forwarded to /decide for this evaluation only (bypasses the cache). */
  personProperties?: Properties;
  /** Returned when Kilden cannot answer (network failure, unknown flag). */
  default?: FlagValue;
}

export interface TransportResponse {
  /** HTTP status; 0 means network error or timeout. */
  status: number;
  /** Response headers, lower-cased keys. */
  headers: Record<string, string>;
  /** Raw response body ("" when unavailable). Never parsed for /capture. */
  body: string;
}

export interface Transport {
  send(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<TransportResponse>;
}

/** Async key-value storage; AsyncStorage-compatible. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** App lifecycle source; the default adapter wraps React Native's AppState. */
export interface AppStateAdapter {
  /** Subscribe to state changes ("active" | "background" | "inactive"); returns unsubscribe. */
  addListener(callback: (state: string) => void): () => void;
}

export type RandomFill = (array: Uint8Array) => Uint8Array;

export interface InitOptions {
  /** Base URL for the Kilden ingest endpoints. */
  apiHost?: string;
  /** Queue length that triggers a flush. */
  flushAt?: number;
  /** Milliseconds between periodic flushes. */
  flushIntervalMs?: number;
  /** Hard cap on queued events; at the cap the NEW event is dropped. */
  maxQueueSize?: number;
  /** Milliseconds per HTTP request before it counts as a timeout. */
  requestTimeoutMs?: number;
  /** Verbose logging plus $-prefix warnings. */
  debug?: boolean;
  /** false turns the whole client into a no-op. */
  enabled?: boolean;
  /**
   * Persist the event queue to storage so events survive the OS killing the
   * app (there is no "will terminate" signal in React Native). Restored on
   * the next launch; delivery stays at-least-once — the server dedups by
   * event uuid. Default false.
   */
  persistQueue?: boolean;
  /** Initial identity token (JWT minted by your backend). */
  identityToken?: string;
  /** Called to (re)fetch the identity token: 60s before expiry and on 401. */
  getIdentityToken?: () => Promise<string | null>;
  /** Extra system properties merged into every event (explicit event properties win). */
  context?: () => Properties;
  /** Storage override; defaults to @react-native-async-storage/async-storage. */
  storage?: KeyValueStorage;
  /** Transport override; defaults to fetch. */
  transport?: Transport;
  /** Entropy override; defaults to expo-crypto, then global crypto.getRandomValues. */
  getRandomValues?: RandomFill;
  /** App lifecycle override; defaults to React Native's AppState. */
  appState?: AppStateAdapter;
}
