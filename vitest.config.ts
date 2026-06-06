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
    // 60s: the CI Neon test branch clones the parent (~15k email_generations rows); the first
    // integration file's hooks pay cold-compute resume + (for db.test.ts) a full-table wipe.
    hookTimeout: 60000,
    testTimeout: 30000,
  },
});
