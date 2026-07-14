/**
 * Spawns the kilden-sdk-spec mock capture server (Go) for the integration
 * tests, mirroring the harness used by the five server SDKs. Requires a Go
 * toolchain and a kilden-sdk-spec checkout (sibling dir or KILDEN_SPEC_DIR).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";

import { MOCK_PORT, MOCK_URL, specDir } from "./helpers.js";

let server: ChildProcess | null = null;

export async function setup(): Promise<void> {
  const cwd = resolve(specDir(), "mockserver");
  // detached: `go run` re-spawns the compiled binary as a child; killing the
  // process GROUP is the only way not to leave an orphan server behind.
  server = spawn("go", ["run", ".", "-addr", `:${MOCK_PORT}`], {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${MOCK_URL}/healthz`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`mock server did not become healthy at ${MOCK_URL} within 30s`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

export async function teardown(): Promise<void> {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGKILL"); // whole process group
    } catch {
      server.kill("SIGKILL");
    }
  }
  server = null;
}
