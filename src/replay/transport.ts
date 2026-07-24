import type { Transport } from "../types.js";

// Replay chunk transport (SPEC-mobile §6.7): its own path, NOT the event
// queue — chunks go to the replay ingest door and Kafka never carries blobs.
// Metadata travels in headers (the query string would leak page_url and
// distinct_id into access logs); the body is the uncompressed JSON array of
// rrweb events (React Native has no native gzip; the server stores the body
// verbatim either way). Any 2xx is success; the body is never parsed.

export interface ChunkMeta {
  writeKey: string;
  sessionId: string;
  recordingId: string;
  distinctId: string;
  chunkIndex: number;
  pageUrl: string;
  hasError: boolean;
  firstEventAt: number; // epoch ms
  lastEventAt: number; // epoch ms
  platform: "ios" | "android";
}

/** Header values reject some characters; distinct_id and the URL are URI-encoded. */
export function chunkHeaders(meta: ChunkMeta): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Kilden-Write-Key": meta.writeKey,
    "X-Kilden-Session-Id": meta.sessionId,
    "X-Kilden-Recording-Id": meta.recordingId,
    "X-Kilden-Distinct-Id": encodeURIComponent(meta.distinctId),
    "X-Kilden-Chunk-Index": String(meta.chunkIndex),
    "X-Kilden-Page-Url": encodeURIComponent(meta.pageUrl),
    "X-Kilden-Has-Error": meta.hasError ? "1" : "0",
    "X-Kilden-First-Event-At": String(meta.firstEventAt),
    "X-Kilden-Last-Event-At": String(meta.lastEventAt),
    "X-Kilden-Platform": meta.platform,
  };
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const TIMEOUT_MS = 15_000;

/**
 * Send one chunk with retry + exponential backoff. Safe to retry: the server
 * is idempotent per (session, recording, chunk_index). A 4xx other than 429
 * is never retried — the chunk is malformed and a retry cannot fix it.
 * Returns true on delivery. `wait` is injectable for tests.
 */
export async function sendChunk(
  transport: Transport,
  url: string,
  meta: ChunkMeta,
  body: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  let backoff = BASE_BACKOFF_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await transport.send(url, body, chunkHeaders(meta), TIMEOUT_MS);
    if (response.status >= 200 && response.status < 300) return true;
    const retryable = response.status === 0 || response.status === 429 || response.status >= 500;
    if (!retryable) return false;
    if (attempt < MAX_ATTEMPTS - 1) {
      await wait(backoff);
      backoff *= 2;
    }
  }
  return false;
}
