import { describe, expect, it } from "vitest";

import { decodeBase64UrlToString, utf8ByteLength } from "../src/encoding.js";

describe("utf8ByteLength", () => {
  it("matches Buffer.byteLength across scripts", () => {
    const samples = ["", "abc", "ñandú", "מִלָּה", "日本語", "🎉 emoji", "a".repeat(1000)];
    for (const sample of samples) {
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, "utf8"));
    }
  });
});

describe("decodeBase64UrlToString", () => {
  it("decodes base64url without padding", () => {
    const encoded = Buffer.from('{"exp":1730003600}', "utf8").toString("base64url");
    expect(decodeBase64UrlToString(encoded)).toBe('{"exp":1730003600}');
  });

  it("decodes unicode payloads", () => {
    const source = '{"sub":"usuario_ñandú 🎉"}';
    const encoded = Buffer.from(source, "utf8").toString("base64url");
    expect(decodeBase64UrlToString(encoded)).toBe(source);
  });

  it("returns null on invalid characters", () => {
    expect(decodeBase64UrlToString("!!not base64!!")).toBeNull();
  });
});
