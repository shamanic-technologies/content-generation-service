import { beforeAll, afterAll, vi } from "vitest";

process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL = process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test";
process.env.SERVICE_SECRET_KEY = "test-service-secret";

beforeAll(async () => {
  // Only run migrations for integration tests (when a real DB is available)
  if (process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL && !process.env.CONTENT_GENERATION_SERVICE_DATABASE_URL.includes("localhost/test")) {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { db, sql } = await import("../src/db/index.js");

    // Wait for the database to accept connections before migrating. In CI it is a container
    // that GitHub health-checks with `pg_isready`, which can still race the first client
    // connect; locally it may be a tunnel that has just come up.
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
    // migration, leaving the schema unmigrated so every integration test failed opaquely with
    // `relation "..." does not exist`. This is also the only place the journal is replayed from
    // an EMPTY database — CI's per-run container starts with nothing in it.
    await migrate(db, { migrationsFolder: "./drizzle" });
  }
  console.log("Test suite starting...");
});
afterAll(() => console.log("Test suite complete."));
