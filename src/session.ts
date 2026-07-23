import type { Logger } from "./log.js";
import type { KeyValueStorage, RandomFill } from "./types.js";
import { uuidv7 } from "./uuid.js";

// $session_id: UUID v7 rotated after 30 minutes of inactivity — the same
// semantics as kilden-sdk-js/src/session.ts, adapted to async storage: the
// live session is held in memory (touch() must stay synchronous inside
// emit()) and written through to storage on a coalesced macrotask.

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const K_SESSION = "kilden_session";

interface StoredSession {
  id: string;
  last: number; // epoch ms of last activity
}

export class SessionManager {
  private session: StoredSession | null = null;
  private persistScheduled = false;

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly random: RandomFill,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Restores the session persisted by a previous process (client hydration). */
  hydrate(raw: string | null): void {
    if (!raw || this.session) return;
    try {
      const parsed = JSON.parse(raw) as StoredSession;
      if (typeof parsed?.id === "string" && typeof parsed?.last === "number") {
        this.session = parsed;
      }
    } catch {
      this.log.debug("stored session was unreadable; starting a fresh one");
    }
  }

  /** Current session id, counting this call as activity; rotates when expired. */
  touch(): string {
    const now = this.now();
    if (!this.session || now - this.session.last > SESSION_TIMEOUT_MS) {
      this.session = { id: uuidv7(this.random), last: now };
    } else {
      this.session = { id: this.session.id, last: now };
    }
    this.schedulePersist();
    return this.session.id;
  }

  private schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    const timer = setTimeout(() => {
      this.persistScheduled = false;
      const session = this.session;
      if (session === null) return;
      void this.storage.setItem(K_SESSION, JSON.stringify(session)).catch(() => {
        this.log.debug("storage write failed for the session");
      });
    }, 0);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}
