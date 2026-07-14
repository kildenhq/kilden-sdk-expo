/**
 * kilden-sdk-spec §4.4: YYYY-MM-DDTHH:MM:SS.mmmZ — UTC, exactly three
 * fractional digits, Z suffix. Date#toISOString produces exactly this form.
 */
export function formatTimestamp(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString();
}

/** Caller-supplied time → spec form; null when uninterpretable (event is dropped). */
export function normalizeTimestamp(input: Date | string): string | null {
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}
