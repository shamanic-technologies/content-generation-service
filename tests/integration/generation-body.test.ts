import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { findGenerationForLead } from "../../src/lib/lead-generation-query.js";
import { withResolvedBody } from "../../src/lib/generation-body.js";
import { closeDb, randomId } from "../helpers/test-db.js";

// Scope cleanup to THIS suite's rows only — the CI database is shared with the other
// integration suites and a full-table wipe would race them.
const WF = "generation-body-resolution-test";
const cleanup = () => db.delete(emailGenerations).where(inArray(emailGenerations.workflowSlug, [WF]));

const EMAIL = "Hey Nicky,\n\nSaw the new onboarding ship last week.\n\nWorth a quick chat?\n\nKevin";

async function insertGen(values: Record<string, unknown>) {
  const [row] = await db
    .insert(emailGenerations)
    .values({
      runId: `run-${randomId()}`,
      brandIds: [],
      workflowSlug: WF,
      ...values,
    } as typeof emailGenerations.$inferInsert)
    .returning();
  return row;
}

describe("generation body resolution against a real row", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("serves the sequence's copy for a row shaped like every generation since Feb 2026", async () => {
    // Written exactly as POST /generate writes today: body columns untouched, copy in sequence.
    const orgId = randomId();
    const leadId = randomId();
    const campaignId = randomId();

    await insertGen({
      orgId,
      leadId,
      campaignId,
      subject: "Quick question",
      sequence: [
        { step: 1, bodyText: EMAIL, bodyHtml: "<p>step one</p>", daysSinceLastStep: 0 },
        { step: 2, bodyText: "Following up", bodyHtml: "<p>Following up</p>", daysSinceLastStep: 3 },
      ],
    });

    const stored = await findGenerationForLead({ orgId, leadId, campaignId });
    expect(stored).toBeDefined();
    expect(stored!.bodyText).toBeNull(); // the retired spelling, straight out of the DB

    const served = withResolvedBody(stored!);
    expect(served.bodyText).toBe(EMAIL);
    expect(served.bodyHtml).toBe("<p>step one</p>");
    expect(served.bodySource).toBe("sequence");
    expect(served.sequence).toHaveLength(2);
  });

  it("leaves a pre-Feb-2026 row (populated body columns) exactly as stored", async () => {
    const orgId = randomId();
    const leadId = randomId();
    const campaignId = randomId();

    await insertGen({
      orgId,
      leadId,
      campaignId,
      subject: "Old shape",
      bodyText: EMAIL,
      bodyHtml: "<p>legacy html</p>",
      sequence: null,
    });

    const served = withResolvedBody((await findGenerationForLead({ orgId, leadId, campaignId }))!);
    expect(served.bodyText).toBe(EMAIL);
    expect(served.bodyHtml).toBe("<p>legacy html</p>");
    expect(served.bodySource).toBe("column");
  });

  it("marks a row with no copy anywhere as `none`", async () => {
    const orgId = randomId();
    const leadId = randomId();
    const campaignId = randomId();

    await insertGen({ orgId, leadId, campaignId, subject: "Subject only", sequence: [] });

    const served = withResolvedBody((await findGenerationForLead({ orgId, leadId, campaignId }))!);
    expect(served.bodyText).toBeNull();
    expect(served.bodyHtml).toBeNull();
    expect(served.bodySource).toBe("none");
  });
});
