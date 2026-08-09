import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    fileParallelism: false,
    maxWorkers: 1,
    // 120s: the first integration file's beforeAll waits for the database to accept connections
    // and then replays the whole journal onto it (in CI, from empty). Generous margin — a
    // retrying connect can burn ~30s on postgres.js CONNECT_TIMEOUT before it succeeds.
    hookTimeout: 120000,
    testTimeout: 30000,
  },
});
