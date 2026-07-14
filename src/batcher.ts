import { utf8ByteLength } from "./encoding.js";
import type { Logger } from "./log.js";
import { formatTimestamp } from "./timestamp.js";
import type { EventPayload, Transport } from "./types.js";
import { USER_AGENT } from "./version.js";

const MAX_EVENTS_PER_REQUEST = 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_RETRIES = 3;

export interface BatcherDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface BatcherOptions {
  url: string;
  writeKey: string;
  transport: Transport;
  timeoutMs: number;
  log: Logger;
  /** Current identity token, if any; sent as Authorization: Bearer. */
  getToken: () => string | null;
  /** Called once per chunk on 401; true = token was refreshed, retry immediately. */
  onUnauthorized: () => Promise<boolean>;
}

/**
 * Delivery to POST /capture per kilden-sdk-spec: chunks of ≤1000 events,
 * ≤5 MiB bodies, retry policy frozen in §4.3. Any 2xx is success and the
 * response body is never parsed. Failed batches are not re-queued.
 *
 * Client twist vs the server SDKs: a 401 with an identity-token refresher
 * configured triggers one refresh + immediate retry (the token expired);
 * without one it drops, same as the spec.
 */
export class Batcher {
  dropped = 0;

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly options: BatcherOptions,
    deps: BatcherDeps = {},
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  async send(events: EventPayload[]): Promise<void> {
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
      await this.sendChunk(events.slice(i, i + MAX_EVENTS_PER_REQUEST));
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    const token = this.options.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
  }

  private async sendChunk(events: EventPayload[]): Promise<void> {
    if (events.length === 0) return;
    const body = JSON.stringify({
      write_key: this.options.writeKey,
      sent_at: formatTimestamp(this.now()),
      batch: events,
    });
    if (utf8ByteLength(body) > MAX_BODY_BYTES) {
      if (events.length === 1) {
        this.dropped += 1;
        this.options.log.warn("dropping 1 event: exceeds the 5 MiB request limit on its own");
        return;
      }
      const mid = Math.ceil(events.length / 2);
      await this.sendChunk(events.slice(0, mid));
      await this.sendChunk(events.slice(mid));
      return;
    }

    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const response = await this.options.transport.send(
        this.options.url,
        body,
        this.headers(),
        this.options.timeoutMs,
      );

      if (response.status >= 200 && response.status < 300) {
        this.options.log.debug(`flushed ${events.length} event(s)`);
        return;
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        if (await this.options.onUnauthorized()) continue;
      }

      const retryable =
        response.status === 429 || response.status >= 500 || response.status === 0;
      if (!retryable) {
        this.dropped += events.length;
        this.options.log.warn(
          `dropping ${events.length} event(s): capture returned ${response.status}`,
        );
        return;
      }
      if (attempt > MAX_RETRIES) {
        this.dropped += events.length;
        this.options.log.warn(
          `dropping ${events.length} event(s): retries exhausted (last status ${response.status})`,
        );
        return;
      }

      const retryAfter =
        response.status === 429 ? Number(response.headers["retry-after"]) : Number.NaN;
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : Math.min(500 * 2 ** (attempt - 1), 30_000) * (0.5 + this.random());
      this.options.log.debug(
        `retrying in ${Math.round(waitMs)}ms (attempt ${attempt}, status ${response.status})`,
      );
      await this.sleep(waitMs);
    }
  }
}
