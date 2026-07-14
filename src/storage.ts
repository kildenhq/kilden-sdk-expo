import type { KeyValueStorage } from "./types.js";

export const K_ANON = "kilden_anon_id";
export const K_DISTINCT = "kilden_distinct_id";
export const K_QUEUE = "kilden_queue";

/** In-memory fallback: the SDK keeps working, identity resets with the process. */
export class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}
