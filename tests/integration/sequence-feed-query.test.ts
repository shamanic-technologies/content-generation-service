import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { readSequenceFeed } from "../../src/lib/sequence-feed-query.js";
import { closeDb, randomId } from "../helpers/test-db.js";

// A feature slug of its own per test: the CI database is shared with other suites.
const slugs: string[] = [];
const newSlug = () => {
  const s = `feed-test-${randomId()}`;
  slugs.push(s);
  return s;
};

async function insertGen(
  featureSlug: string,
  opts: { leadId?: string | null; body?: string; createdAt: Date; firstName?: string; completionRunIds?: string[] | null; completionRunsReason?: string },
) {
  const [row] = await db
    .insert(emailGenerations)
    .values({
      orgId: randomId(),
      runId: `run-${randomId()}`,
      leadId: opts.leadId === undefined ? randomId() : opts.leadId,
      campaignId: randomId(),
      brandIds: [randomId()],
      featureSlug,
      workflowSlug: "wf-v3",
      promptType: "cold-email-v41",
      model: "gemini-3.1-pro-preview",
      leadFirstName: opts.firstName ?? "Marie",
      sequence: opts.body === undefined ? [] : [{ step: 1, bodyText: opts.body, daysSinceLastStep: 0 }],
      tokensInput: 6400,
      tokensOutput: 184,
      completionRunIds: opts.completionRunIds === undefined ? [`chat-${randomId()}`] : opts.completionRunIds,
      completionRunsReason: opts.completionRunsReason ?? null,
      createdAt: opts.createdAt,
    })
    .returning();
  return row;
}

afterAll(async () => {
  if (slugs.length) await db.delete(emailGenerations).where(inArray(emailGenerations.featureSlug, slugs));
  await closeDb();
});

describe("readSequenceFeed", () => {
  it("pages every sequence once, in write order, and resumes from the cursor", async () => {
    const f = newSlug();
    const t0 = Date.now() - 3600_000;
    const a = await insertGen(f, { body: "Hi Marie,\n\nOne — two.", createdAt: new Date(t0) });
    const b = await insertGen(f, { body: "Marie, I saw your post.", createdAt: new Date(t0 + 1000) });
    const c = await insertGen(f, { body: "I noticed.\nSecond line", createdAt: new Date(t0 + 2000) });
    await insertGen(f, { leadId: null, body: "no lead", createdAt: new Date(t0 + 3000) });

    const p1 = await readSequenceFeed({ featureSlug: f, cursor: null, limit: 2, settleSeconds: 0 });
    expect(p1.sequences.map((s) => s.generationId)).toEqual([a.id, b.id]);
    expect(p1.hasMore).toBe(true);
    expect(p1.sequences[0]).toMatchObject({
      model: "gemini-3.1-pro-preview",
      promptType: "cold-email-v41",
      workflowSlug: "wf-v3",
      firstEmail: { layout: "double_line_breaks", opening: "greeting", dash: "em" },
    });
    expect(p1.sequences[1].firstEmail).toEqual({ layout: "one_block", opening: "first_name_alone", dash: "none" });

    const { decodeCursor } = await import("../../src/lib/sequence-feed-query.js");
    const p2 = await readSequenceFeed({ featureSlug: f, cursor: decodeCursor(p1.nextCursor!), limit: 2, settleSeconds: 0 });
    expect(p2.sequences.map((s) => s.generationId)).toEqual([c.id]);
    expect(p2.hasMore).toBe(false);
    expect(p2.sequences[0].firstEmail).toEqual({ layout: "single_line_breaks", opening: "no_greeting", dash: "none" });

    // caught up: same cursor handed back
    const p3 = await readSequenceFeed({ featureSlug: f, cursor: decodeCursor(p2.nextCursor!), limit: 2, settleSeconds: 0 });
    expect(p3.sequences).toEqual([]);
    expect(p3.nextCursor).toBe(p2.nextCursor);
  });

  it("does not skip rows sharing one created_at across a page boundary", async () => {
    const f = newSlug();
    const at = new Date(Date.now() - 3600_000);
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await insertGen(f, { body: "Hi", createdAt: at })).id);
    const seen: string[] = [];
    const { decodeCursor } = await import("../../src/lib/sequence-feed-query.js");
    let cursor: ReturnType<typeof decodeCursor> = null;
    for (;;) {
      const p = await readSequenceFeed({ featureSlug: f, cursor, limit: 2, settleSeconds: 0 });
      seen.push(...p.sequences.map((s) => s.generationId));
      if (!p.hasMore) break;
      cursor = decodeCursor(p.nextCursor!);
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("holds back rows younger than the settle window, and serves null classes for a sequence with no copy", async () => {
    const f = newSlug();
    const old = await insertGen(f, { createdAt: new Date(Date.now() - 3600_000) });
    await insertGen(f, { body: "Hi", createdAt: new Date() });
    const p = await readSequenceFeed({ featureSlug: f, cursor: null, limit: 10, settleSeconds: 60 });
    expect(p.sequences.map((s) => s.generationId)).toEqual([old.id]);
    expect(p.sequences[0].firstEmail).toBeNull();
  });

  it("serves the completion run and tokens, a stated reason, and ends the page at a row not matched yet", async () => {
    const f = newSlug();
    const t0 = Date.now() - 3600_000;
    const a = await insertGen(f, { body: "Hi", createdAt: new Date(t0), completionRunIds: ["chat-run-1"] });
    const b = await insertGen(f, { body: "Hi", createdAt: new Date(t0 + 1000), completionRunIds: null, completionRunsReason: "cannot tell" });
    const pending = await insertGen(f, { body: "Hi", createdAt: new Date(t0 + 2000), completionRunIds: null });
    await insertGen(f, { body: "Hi", createdAt: new Date(t0 + 3000) });

    const p = await readSequenceFeed({ featureSlug: f, cursor: null, limit: 10, settleSeconds: 0 });
    expect(p.sequences.map((s) => s.generationId)).toEqual([a.id, b.id]);
    expect(p.hasMore).toBe(false);
    expect(p.sequences[0]).toMatchObject({ completionRunIds: ["chat-run-1"], completionRunsReason: null, tokensInput: 6400, tokensOutput: 184 });
    expect(p.sequences[1]).toMatchObject({ completionRunIds: null, completionRunsReason: "cannot tell" });

    await db.update(emailGenerations).set({ completionRunIds: ["chat-run-3"] }).where(inArray(emailGenerations.id, [pending.id]));
    const { decodeCursor } = await import("../../src/lib/sequence-feed-query.js");
    const p2 = await readSequenceFeed({ featureSlug: f, cursor: decodeCursor(p.nextCursor!), limit: 10, settleSeconds: 0 });
    expect(p2.sequences.map((s) => s.generationId)[0]).toBe(pending.id);
    expect(p2.sequences).toHaveLength(2);
  });
});
