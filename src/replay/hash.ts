// djb2 over the JPEG data-URI (SPEC-mobile §6.4): cheap even on strings of
// hundreds of KB, and a collision only costs one dropped frame.

/** 32-bit unsigned djb2. */
export function djb2(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}
