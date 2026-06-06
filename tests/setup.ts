import { beforeAll, afterAll, vi } from "vitest";

process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL = process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test";
process.env.SERVICE_SECRET_KEY = "test-service-secret";

beforeAll(async () => {
  // Only run migrations for integration tests (when a real DB is available)
  if (process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL && !process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL.includes("localhost/test")) {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { db, sql } = await import("../src/db/index.js");

    // The CI Neon test branch scales to zero; the FIRST integration file's first connection
    // hits a resuming compute and postgres.js throws `write CONNECT_TIMEOUT`. Warm the compute
    // with a retrying SELECT 1 BEFORE migrating, so the cold-start is absorbed here.
    for (let attempt = 1; ; attempt++) {
      try {
        await sql`select 1`;
        break;
      } catch (e) {
        if (attempt >= 6) throw e;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    // Fail LOUD if migrations don't apply. Swallowing here (the old behaviour) hid a skipped
    // migration on cold-start, leaving the schema unmigrated so every integration test failed
    // opaquely with `relation "..." does not exist`.
    await migrate(db, { migrationsFolder: "./drizzle" });
  }
  console.log("Test suite starting...");
});
afterAll(() => console.log("Test suite complete."));
