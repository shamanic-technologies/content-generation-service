import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { cursorAfter, readUnhandledGenerations, type GenerationCursor } from "../../src/lib/outcome-backfill-query.js";
import { closeDb, randomId } from "../helpers/test-db.js";

const ids: string[] = [];

async function insertAt(createdAt: string, opts: { declared?: boolean } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO email_generations (org_id, run_id, lead_id, campaign_id, brand_ids, feature_slug, generation_run_id, created_at, outcomes_declared_at)
    VALUES (${randomId()}, ${`run-${randomId()}`}, ${randomId()}, ${randomId()}, ${sql.array([randomId()])}, 'sales-cold-email-outreach',
            ${`gen-${randomId()}`}, ${createdAt}::timestamptz, ${opts.declared ? sql`now()` : null})
    RETURNING id::text`;
  ids.push(row.id);
  return row.id;
}

afterAll(async () => {
  if (ids.length) await db.delete(emailGenerations).where(inArray(emailGenerations.id, ids));
  await closeDb();
});

describe("readUnhandledGenerations", () => {
  it("serves created_at as the driver returns it (text) and pages rows of one millisecond without skipping any", async () => {
    // Far in the past so no other suite's rows fall in this window.
    const a = await insertAt("2001-01-01 00:00:00.000100+00");
    const b = await insertAt("2001-01-01 00:00:00.000200+00");
    const c = await insertAt("2001-01-01 00:00:00.000300+00");
    await insertAt("2001-01-01 00:00:00.000400+00", { declared: true });

    const seen: string[] = [];
    let cursor: GenerationCursor | null = { createdAt: "2000-12-31 00:00:00+00", id: "00000000-0000-0000-0000-000000000000" };
    for (;;) {
      const rows = await readUnhandledGenerations(cursor, 1);
      if (rows.length === 0 || !ids.includes(rows[0].id)) break;
      expect(typeof rows[0].created_at).toBe("string");
      seen.push(rows[0].id);
      cursor = cursorAfter(rows);
    }
    expect(seen).toEqual([a, b, c]);
    // Microseconds survive (a Date would round them away); the offset is the session's time zone.
    expect(cursor?.createdAt).toMatch(/^2001-01-01 \d{2}:\d{2}:00\.0003[+-]\d{2}(:\d{2})?$/);
  });
});
