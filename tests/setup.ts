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

// Our voice (client-comms) is read live from chat-service on every generation. Unit suites count
// the `/complete` fetch calls, so the read is stubbed once here; the real module is exercised by
// tests/unit/client-comms-voice.test.ts (vi.importActual).
vi.mock("../src/lib/client-comms-voice.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/client-comms-voice.js")>();
  return { ...actual, readClientCommsVoice: vi.fn(async () => "TEST VOICE: answer first, short, plain words.") };
});

// Which dynasties hold a template is a raw-SQL read (src/lib/dynasty-membership.ts), and most unit
// suites hand-roll a db mock without `execute`. Stubbed once here as "in no dynasty"; the real
// module is exercised by tests/unit/template-dynasty-rows.test.ts and the integration suite
// (vi.importActual).
vi.mock("../src/lib/dynasty-membership.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dynasty-membership.js")>();
  return {
    ...actual,
    dynastiesHolding: vi.fn(async () => []),
    assertMayActivate: vi.fn(async () => undefined),
    assertNotDynastySource: vi.fn(async () => undefined),
  };
});

// Which model names chat-service accepts is read live from its `GET /internal/models`
// (src/lib/chat-model-catalogue.ts, LLM-DYNASTY-1022-CG). Unit suites count fetch calls, so the
// read is stubbed once here with chat-service's catalogue as served on 2026-10-22 (16 LLM dynasty
// slugs, each head's model id, the legacy aliases); the real module is exercised by
// tests/unit/chat-model-catalogue.test.ts (vi.importActual).
vi.mock("../src/lib/chat-model-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/chat-model-catalogue.js")>();
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/chat-service-models-2026-10-22.json", import.meta.url), "utf8")
  ) as { models: Array<{ model: string; provider: string; dynasty: string }> };
  const entries = fixture.models.map(({ model, provider, dynasty }) => ({ model, provider, dynasty })) as Awaited<
    ReturnType<typeof actual.listChatModels>
  >;
  const find = async (model: string) => entries.find((e) => e.model === model) ?? null;
  return {
    ...actual,
    listChatModels: vi.fn(async () => entries),
    findChatModel: vi.fn(find),
    resolveChatModel: vi.fn(async (model: string) => {
      const hit = await find(model);
      if (!hit) throw new actual.UnknownModelError(model, entries.map((e) => e.model));
      return hit;
    }),
  };
});

// Outcome declarations to runs-service (COST-ACCOUNTING-1023-P1) are sent in the background after
// a generation is stored. Unit suites count fetch calls and hand-roll db mocks, so the sender is
// stubbed once here; the real module is exercised by tests/unit/outcome-declarations.test.ts.
vi.mock("../src/lib/outcome-declarations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/outcome-declarations.js")>();
  return { ...actual, declareStoredOutcomes: vi.fn(async () => undefined), declareRenderOutcomes: vi.fn(async () => undefined), startOutcomeDeclarationSweep: vi.fn() };
});
