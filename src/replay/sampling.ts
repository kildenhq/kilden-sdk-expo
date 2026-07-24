import type { KeyValueStorage } from "../types.js";

// Sampling is decided ONCE per session and sticky (SPEC-mobile §6.2, the web
// SDK's semantics verbatim): the same session either records for its whole
// life or not at all, and the decision survives app restarts. It is persisted
// next to the session id, so a rotation naturally forces a fresh roll.

export const K_REPLAY_SAMPLE = "kilden_replay_sample";

interface StoredDecision {
  sid: string;
  sampled: boolean;
}

/**
 * Returns the sticky sampling decision for sessionId, rolling once (and
 * persisting) the first time a session is seen. rng is injectable for tests.
 * Storage failure degrades to an unpersisted decision — never a throw.
 */
export async function decideSampling(
  storage: KeyValueStorage,
  sessionId: string,
  sampleRate: number,
  rng: () => number = Math.random,
): Promise<boolean> {
  try {
    const raw = await storage.getItem(K_REPLAY_SAMPLE);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredDecision;
      if (parsed.sid === sessionId && typeof parsed.sampled === "boolean") {
        return parsed.sampled; // sticky: never re-roll within a session
      }
    }
  } catch {
    // fall through to a fresh decision
  }
  const clamped = Math.max(0, Math.min(1, sampleRate));
  const sampled = rng() < clamped;
  try {
    await storage.setItem(K_REPLAY_SAMPLE, JSON.stringify({ sid: sessionId, sampled }));
  } catch {
    // best-effort; an unpersisted decision just re-rolls next launch
  }
  return sampled;
}
