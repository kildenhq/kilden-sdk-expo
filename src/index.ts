import { KildenClient } from "./client.js";
import type { SessionRecordingConfig } from "./flags.js";
import type {
  AppStateAdapter,
  FlagOptions,
  FlagValue,
  IdentifyOptions,
  InitOptions,
  JsonValue,
  KeyValueStorage,
  Properties,
  RandomFill,
  TrackOptions,
  Transport,
  TransportResponse,
} from "./types.js";
import { VERSION } from "./version.js";

export function createClient(writeKey: string, options: InitOptions = {}): KildenClient {
  return new KildenClient(writeKey, options);
}

const MAX_PREINIT_CALLS = 10_000;

/**
 * Default singleton: `kilden.init(...)` once, use anywhere. Calls made
 * before init are buffered and replayed in order (docs/10 contract); flag
 * reads before init resolve to their default instead of hanging.
 */
class KildenSingleton {
  private client: KildenClient | null = null;
  private preinit: Array<(client: KildenClient) => void> = [];

  init(writeKey: string, options: InitOptions = {}): void {
    if (this.client) {
      console.warn("[kilden] init() called twice; ignoring the second call");
      return;
    }
    this.client = new KildenClient(writeKey, options);
    const calls = this.preinit.splice(0);
    for (const call of calls) call(this.client);
  }

  track(event: string, properties?: Properties, options?: TrackOptions): void {
    this.dispatch((client) => client.track(event, properties, options));
  }

  screen(name: string, properties?: Properties, options?: TrackOptions): void {
    this.dispatch((client) => client.screen(name, properties, options));
  }

  identify(distinctId: string, traits?: Properties, options?: IdentifyOptions): void {
    this.dispatch((client) => client.identify(distinctId, traits, options));
  }

  alias(aliasId: string): void {
    this.dispatch((client) => client.alias(aliasId));
  }

  reset(): void {
    this.dispatch((client) => client.reset());
  }

  setIdentityToken(token: string | null): void {
    this.dispatch((client) => client.setIdentityToken(token));
  }

  async getDistinctId(): Promise<string> {
    if (!this.client) {
      console.warn("[kilden] getDistinctId() before init(); returning \"\"");
      return "";
    }
    return this.client.getDistinctId();
  }

  async getFeatureFlag(flagKey: string, options?: FlagOptions): Promise<FlagValue> {
    if (!this.client) return options?.default ?? false;
    return this.client.getFeatureFlag(flagKey, options);
  }

  getSessionRecordingConfig(): SessionRecordingConfig | null {
    return this.client?.getSessionRecordingConfig() ?? null;
  }

  async isFeatureEnabled(flagKey: string, options?: FlagOptions): Promise<boolean> {
    if (!this.client) return options?.default === true;
    return this.client.isFeatureEnabled(flagKey, options);
  }

  async flush(): Promise<void> {
    return this.client?.flush();
  }

  async close(): Promise<void> {
    return this.client?.close();
  }

  private dispatch(call: (client: KildenClient) => void): void {
    if (this.client) {
      call(this.client);
      return;
    }
    if (this.preinit.length >= MAX_PREINIT_CALLS) return;
    this.preinit.push(call);
  }
}

const kilden = new KildenSingleton();

export default kilden;
export { KildenClient, VERSION };
export type {
  AppStateAdapter,
  FlagOptions,
  FlagValue,
  IdentifyOptions,
  InitOptions,
  JsonValue,
  KeyValueStorage,
  Properties,
  RandomFill,
  TrackOptions,
  Transport,
  TransportResponse,
};
export { MemoryStorage } from "./storage.js";
export { FetchTransport } from "./transport.js";
export { attachNavigationTracking } from "./navigation.js";
export type { NavigationContainerLike, NavigationRouteLike } from "./navigation.js";
export { SESSION_TIMEOUT_MS } from "./session.js";
export type { SessionRecordingConfig };
