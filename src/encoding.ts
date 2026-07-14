/** UTF-8 byte length without TextEncoder (not guaranteed on every RN runtime). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i) as number;
    if (code > 0xffff) i++; // surrogate pair consumed
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const B64_LOOKUP: Record<string, number> = {};
{
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < alphabet.length; i++) {
    B64_LOOKUP[alphabet[i] as string] = i;
  }
  B64_LOOKUP["+"] = 62;
  B64_LOOKUP["-"] = 62;
  B64_LOOKUP["/"] = 63;
  B64_LOOKUP["_"] = 63;
}

/** Decode base64/base64url (padding optional) into a UTF-8 string; null on bad input. */
export function decodeBase64UrlToString(input: string): string | null {
  const clean = input.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = B64_LOOKUP[ch];
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return utf8Decode(bytes);
}

function utf8Decode(bytes: number[]): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i] as number;
    let code: number;
    let extra: number;
    if (b0 < 0x80) {
      code = b0;
      extra = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      code = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      code = b0 & 0x07;
      extra = 3;
    } else {
      return null;
    }
    for (let j = 1; j <= extra; j++) {
      const bn = bytes[i + j];
      if (bn === undefined || (bn & 0xc0) !== 0x80) return null;
      code = (code << 6) | (bn & 0x3f);
    }
    i += extra + 1;
    out += String.fromCodePoint(code);
  }
  return out;
}
