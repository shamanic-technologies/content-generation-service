import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations, whatsappGenerations } from "../../src/db/schema.js";
import { getDynasty, readDynastyOutputs, resolveDynastyHead } from "../../src/lib/template-dynasty-query.js";
import { readSequenceFeed } from "../../src/lib/sequence-feed-query.js";
import { WHATSAPP_DYNASTY_SEEDS, WHATSAPP_TEMPLATE_V2 } from "../../src/lib/whatsapp-templates.js";
import { closeDb, randomId } from "../helpers/test-db.js";

const slugs: string[] = [];
afterAll(async () => {
  if (slugs.length) {
    await db.delete(whatsappGenerations).where(inArray(whatsappGenerations.featureSlug, slugs));
    await db.delete(emailGenerations).where(inArray(emailGenerations.featureSlug, slugs));
  }
  await closeDb();
});

async function insertWa(featureSlug: string, decision: "write" | "later", createdAt: Date, promptType = "whatsapp-signup-v2") {
  const [row] = await db
    .insert(whatsappGenerations)
    .values({
      orgId: randomId(), runId: `run-${randomId()}`, brandIds: [randomId()], campaignId: randomId(), leadId: randomId(),
      featureSlug, workflowSlug: "cold-whatsapp-outreach-zaurak-v18", promptType, model: "claude-opus-5-5",
      decision, bubbles: decision === "write" ? ["hey", "a question?"] : [], createdAt,
    })
    .returning();
  return row;
}

describe("WhatsApp template dynasties (WA-TEMPLATES-1023)", () => {
  it("the migration seeded one dynasty per pipe, v1 deprecated Upgraded, v2 the active head", async () => {
    for (const seed of WHATSAPP_DYNASTY_SEEDS) {
      const d = await getDynasty(seed.slug);
      expect(d).toMatchObject({ featureSlug: "cold-whatsapp-outreach", legKey: seed.legKey, identity: "named", head: seed.types[1], status: "active" });
      expect(d.versions.map((v) => [v.type, v.position, v.status])).toEqual([
        [seed.types[0], 1, "deprecated"],
        [seed.types[1], 2, "active"],
      ]);
      const { template } = await resolveDynastyHead(seed.slug);
      expect(template.prompt).toBe(WHATSAPP_TEMPLATE_V2);
    }
  });

  it("serves sent WhatsApp messages in the sequence feed, merged with emails in write order", async () => {
    const f = `wa-feed-${randomId()}`;
    slugs.push(f);
    const t0 = Date.now() - 3600_000;
    const [email] = await db.insert(emailGenerations).values({
      orgId: randomId(), runId: `run-${randomId()}`, leadId: randomId(), campaignId: randomId(), brandIds: [randomId()],
      featureSlug: f, promptType: "cold-email-v41", model: "m", sequence: [], createdAt: new Date(t0 + 1000),
    }).returning();
    const wa1 = await insertWa(f, "write", new Date(t0));
    await insertWa(f, "later", new Date(t0 + 1500));
    const wa2 = await insertWa(f, "write", new Date(t0 + 2000));

    const p1 = await readSequenceFeed({ featureSlug: f, cursor: null, limit: 2, settleSeconds: 0 });
    expect(p1.sequences.map((s) => [s.generationId, s.channel])).toEqual([[wa1.id, "whatsapp"], [email.id, "email"]]);
    expect(p1.hasMore).toBe(true);
    const { decodeCursor } = await import("../../src/lib/sequence-feed-query.js");
    const p2 = await readSequenceFeed({ featureSlug: f, cursor: decodeCursor(p1.nextCursor!), limit: 2, settleSeconds: 0 });
    expect(p2.sequences.map((s) => s.generationId)).toEqual([wa2.id]);
    expect(p2.sequences[0]).toMatchObject({ promptType: "whatsapp-signup-v2", firstEmail: null, generationRunId: null });
    expect(p2.hasMore).toBe(false);
  });

  it("a WhatsApp dynasty's outputs are its sent messages", async () => {
    const f = `wa-out-${randomId()}`;
    slugs.push(f);
    const row = await insertWa(f, "write", new Date(), "whatsapp-paid-v2");
    const { outputs } = await readDynastyOutputs("whatsapp-paid-honest-read", 5);
    expect(outputs[0]).toMatchObject({ generationId: row.id, promptType: "whatsapp-paid-v2", subject: null, emails: [{ step: 1, bodyText: "hey\n\na question?", daysSinceLastStep: 0 }] });
  });
});
