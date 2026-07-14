import { decodeBase64UrlToString } from "./encoding.js";
import type { Logger } from "./log.js";

const REFRESH_MARGIN_MS = 60_000;

/** exp claim of a JWT in epoch ms; null when unparseable. Signature is NOT verified. */
export function parseExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = decodeBase64UrlToString(parts[1] as string);
  if (payload === null) return null;
  try {
    const claims = JSON.parse(payload) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Holds the identity token (docs/11): the token is minted by the customer's
 * backend (the server SDKs' IdentitySigner / POST /kilden/identity endpoint)
 * and this SDK only carries it. Refreshes 60s before expiry when a refresher
 * is configured, and once reactively on 401.
 */
export class TokenManager {
  private token: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<string | null> | null = null;

  constructor(
    private readonly refresher: (() => Promise<string | null>) | undefined,
    private readonly log: Logger,
  ) {}

  get(): string | null {
    return this.token;
  }

  set(token: string | null): void {
    this.token = token;
    this.schedule();
  }

  async refresh(): Promise<string | null> {
    if (!this.refresher) return null;
    this.refreshing ??= this.refresher().then(
      (token) => {
        this.refreshing = null;
        if (token) this.set(token);
        return token;
      },
      () => {
        this.refreshing = null;
        this.log.warn("identity token refresh failed");
        return null;
      },
    );
    return this.refreshing;
  }

  /** true = a fresh token is in place and the batch is worth retrying. */
  async handle401(): Promise<boolean> {
    const before = this.token;
    const after = await this.refresh();
    return after !== null && after !== before;
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.stop();
    if (!this.refresher || !this.token) return;
    const expMs = parseExpMs(this.token);
    if (expMs === null) return;
    const delay = Math.max(0, expMs - REFRESH_MARGIN_MS - Date.now());
    this.timer = setTimeout(() => void this.refresh(), delay);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
