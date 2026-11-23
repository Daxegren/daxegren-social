import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "web/test/**/*.test.{ts,tsx}"],
    globals: true,
    // Database tests apply every migration in WASM Postgres, and several test files run side by side, so 5 s is too tight.
    testTimeout: 30_000,
  },
});
