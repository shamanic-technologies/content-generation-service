import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { cursorAfter, readRevisitedGenerations, readSiblingCandidates, readUnhandledGenerations, type GenerationCursor } from "../../src/lib/outcome-backfill-query.js";
import { closeDb, randomId } from "../helpers/test-db.js";

const ids: string[] = [];

async function insertAt(createdAt: string, opts: { declared?: boolean; error?: string } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO email_generations (org_id, run_id, lead_id, campaign_id, brand_ids, feature_slug, generation_run_id, created_at, outcomes_declared_at, outcomes_error)
    VALUES (${randomId()}, ${`run-${randomId()}`}, ${randomId()}, ${randomId()}, ${sql.array([randomId()])}, 'sales-cold-email-outreach',
            ${`gen-${randomId()}`}, ${createdAt}::timestamptz, ${opts.declared ? sql`now()` : null}, ${opts.error ?? null})
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

describe("readRevisitedGenerations (LEDGER-RESIDUAL-1025)", () => {
  it("reads only rows marked with a reason the rules no longer give, never a declared one", async () => {
    const retired = await insertAt("2002-01-01 00:00:00.0001+00", { error: "backfill: retired product (pr-cold-email-outreach)" });
    const noLead = await insertAt("2002-01-01 00:00:00.0002+00", { error: "backfill: no lead id stored on the email" });
    const parent = await insertAt("2002-01-01 00:00:00.0003+00", { error: "backfill: parent run is campaign-service/c-1, not a workflow run" });
    await insertAt("2002-01-01 00:00:00.0004+00", { error: "backfill: no lead id nor address stored on the email" });
    await insertAt("2002-01-01 00:00:00.0005+00", { error: "backfill: generation run not readable under the email's org" });
    await insertAt("2002-01-01 00:00:00.0006+00", { declared: true, error: "backfill: no lead id stored on the email" });
    await insertAt("2002-01-01 00:00:00.0007+00");

    const rows = await readRevisitedGenerations({ createdAt: "2001-12-31 00:00:00+00", id: "00000000-0000-0000-0000-000000000000" }, 100);
    const mine = rows.filter((r) => ids.includes(r.id)).map((r) => r.id);
    expect(mine).toEqual([retired, noLead, parent]);
    expect(Array.isArray(rows.find((r) => r.id === retired)?.brand_ids)).toBe(true);
  });
});

describe("readSiblingCandidates (LEDGER-RESIDUAL-1025-SIBLINGS)", () => {
  it("reads undeclared rows a backfill marked, never one this pass already decided", async () => {
    const a = await insertAt("2003-01-01 00:00:00.0001+00", { error: "backfill: no lead id nor address stored on the email" });
    const b = await insertAt("2003-01-01 00:00:00.0002+00", { error: "backfill: retired product whose spend is on our run (stays produced none)" });
    await insertAt("2003-01-01 00:00:00.0003+00", { error: "backfill: siblings: parent holds 2+ writers (was: backfill: x)" });
    await insertAt("2003-01-01 00:00:00.0004+00", { declared: true, error: "backfill: x" });
    await insertAt("2003-01-01 00:00:00.0005+00", { error: "runs-service 409" });
    await insertAt("2003-01-01 00:00:00.0006+00");

    const rows = await readSiblingCandidates({ createdAt: "2002-12-31 00:00:00+00", id: "00000000-0000-0000-0000-000000000000" }, 100);
    const mine = rows.filter((r) => ids.includes(r.id));
    expect(mine.map((r) => r.id)).toEqual([a, b]);
    expect(mine[0].outcomes_error).toBe("backfill: no lead id nor address stored on the email");
  });
});
