// The registry behind <KildenMask> (SPEC-mobile §6.6). Components register a
// measure function; the recorder measures ALL of them at every capture — a
// mask that cannot be measured makes measureAll() return null, and the
// caller drops the whole frame (fail-closed: a frame is never uploaded with
// a mask in an unknown position).

/** A masked region in window dp space. */
export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskHandle {
  /** Resolve the subtree's current window rect; null when it cannot be known. */
  measure: () => Promise<MaskRect | null>;
}

export class MaskRegistry {
  private handles = new Set<MaskHandle>();

  /** Register a mask; returns its unregister function. */
  register(handle: MaskHandle): () => void {
    this.handles.add(handle);
    return () => this.handles.delete(handle);
  }

  isEmpty(): boolean {
    return this.handles.size === 0;
  }

  /** Every registered rect, or null when ANY measurement failed. */
  async measureAll(): Promise<MaskRect[] | null> {
    const rects = await Promise.all([...this.handles].map((handle) => handle.measure()));
    if (rects.some((rect) => rect === null)) return null;
    return rects as MaskRect[];
  }
}
