import type { Transport, TransportResponse } from "./types.js";

/**
 * fetch-based transport. Never throws: network errors, timeouts and abort all
 * come back as status 0, which the batcher treats as retryable.
 */
export class FetchTransport implements Transport {
  async send(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<TransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers?.forEach?.((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      let text = "";
      try {
        text = await response.text();
      } catch {
        // A response whose body cannot be read (connection cut mid-response)
        // never completed: report it as a network error so it is retried.
        return { status: 0, headers: responseHeaders, body: "" };
      }
      return { status: response.status, headers: responseHeaders, body: text };
    } catch {
      return { status: 0, headers: {}, body: "" };
    } finally {
      clearTimeout(timer);
    }
  }
}
