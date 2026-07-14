import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one mock server (reset/fail arming are global
    // state): files must not run concurrently.
    fileParallelism: false,
  },
});
