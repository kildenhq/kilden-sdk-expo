import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { USER_AGENT, VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("follows the kilden-<lang>/<version> User-Agent convention", () => {
    expect(USER_AGENT).toBe(`kilden-expo/${VERSION}`);
  });
});
