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
    // 120s: the CI Neon test branch scales to zero. The first integration file's beforeAll
    // warms the compute with a retrying SELECT 1 (each cold connect can burn ~30s on
    // postgres.js CONNECT_TIMEOUT before the retry succeeds) and then migrates; db.test.ts also
    // pays a full-table wipe of the ~15k cloned rows. Generous margin for that one-time resume.
    hookTimeout: 120000,
    testTimeout: 30000,
  },
});
