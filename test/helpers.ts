import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const MOCK_PORT = Number(process.env["KILDEN_MOCK_PORT"] ?? 18093);
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

/** Public key the mock server knows out of the box. */
export const PUBLIC_KEY = "wk_test_public";

export function specDir(): string {
  const fromEnv = process.env["KILDEN_SPEC_DIR"];
  const dir = fromEnv ?? resolve(import.meta.dirname, "../../kilden-sdk-spec");
  if (!existsSync(dir)) {
    throw new Error(
      `kilden-sdk-spec checkout not found at ${dir}; set KILDEN_SPEC_DIR to your checkout`,
    );
  }
  return dir;
}

export function readVectors<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(specDir(), "vectors", file), "utf8")) as T;
}

export async function mockReset(): Promise<void> {
  await fetch(`${MOCK_URL}/__mock/reset`, { method: "POST" });
}

export interface CapturedEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

export async function mockCaptured(): Promise<{
  batches: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>;
  events: CapturedEvent[];
}> {
  const response = await fetch(`${MOCK_URL}/__mock/captured`);
  const parsed = (await response.json()) as {
    batches?: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>;
    events?: CapturedEvent[];
  };
  return { batches: parsed.batches ?? [], events: parsed.events ?? [] };
}

export async function mockFail(spec: {
  times?: number;
  status?: number;
  retry_after?: number;
  mode?: "timeout" | "corrupt" | "cut";
  delay_ms?: number;
}): Promise<void> {
  await fetch(`${MOCK_URL}/__mock/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
}

export async function mockFlags(
  flags: Array<{
    key: string;
    active: boolean;
    rollout_percentage?: number;
    variants?: Array<{ key: string; rollout_percentage: number }>;
  }>,
): Promise<void> {
  await fetch(`${MOCK_URL}/__mock/flags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flags }),
  });
}

export const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ISO_MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const ANON_ID_RE =
  /^anon_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
