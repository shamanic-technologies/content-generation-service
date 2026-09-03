import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { findGenerationForLead } from "../../src/lib/lead-generation-query.js";
import { closeDb, randomId } from "../helpers/test-db.js";

// Scope cleanup to THIS suite's rows only — the CI database is shared with the other
// integration suites and a full-table wipe would race them.
const WF = "campaign-scoped-by-lead-test";
const cleanup = () => db.delete(emailGenerations).where(inArray(emailGenerations.workflowSlug, [WF]));

async function insertGen(opts: {
  orgId: string;
  leadId: string;
  campaignId: string;
  brandIds: string[];
  subject: string;
  createdAt?: Date;
}) {
  const [row] = await db
    .insert(emailGenerations)
    .values({
      orgId: opts.orgId,
      runId: `run-${randomId()}`,
      leadId: opts.leadId,
      campaignId: opts.campaignId,
      brandIds: opts.brandIds,
      workflowSlug: WF,
      subject: opts.subject,
      createdAt: opts.createdAt ?? new Date(),
    })
    .returning();
  return row;
}

describe("findGenerationForLead", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("returns the right email for each campaign of one brand", async () => {
    // The production shape this exists for: one person, one brand, two campaigns.
    const orgId = randomId();
    const brandId = randomId();
    const leadId = randomId();
    const campaignA = randomId();
    const campaignB = randomId();

    await insertGen({ orgId, leadId, campaignId: campaignA, brandIds: [brandId], subject: "From campaign A" });
    await insertGen({ orgId, leadId, campaignId: campaignB, brandIds: [brandId], subject: "From campaign B" });

    const a = await findGenerationForLead({ orgId, leadId, campaignId: campaignA });
    const b = await findGenerationForLead({ orgId, leadId, campaignId: campaignB });

    expect(a?.subject).toBe("From campaign A");
    expect(a?.campaignId).toBe(campaignA);
    expect(b?.subject).toBe("From campaign B");
    expect(b?.campaignId).toBe(campaignB);
  });

  it("combines with the brand scope", async () => {
    const orgId = randomId();
    const brandA = randomId();
    const brandB = randomId();
    const leadId = randomId();
    const campaign = randomId();

    await insertGen({ orgId, leadId, campaignId: campaign, brandIds: [brandA], subject: "Brand A pitch" });
    await insertGen({ orgId, leadId, campaignId: randomId(), brandIds: [brandB], subject: "Brand B pitch" });

    const row = await findGenerationForLead({ orgId, leadId, brandId: brandA, campaignId: campaign });
    expect(row?.subject).toBe("Brand A pitch");
  });

  it("finds nothing when that campaign never wrote to the person", async () => {
    const orgId = randomId();
    const leadId = randomId();
    await insertGen({ orgId, leadId, campaignId: randomId(), brandIds: [randomId()], subject: "Only one" });

    const row = await findGenerationForLead({ orgId, leadId, campaignId: randomId() });
    expect(row).toBeUndefined();
  });

  it("stays org-scoped — another org's campaign is never returned", async () => {
    const leadId = randomId();
    const campaign = randomId();
    await insertGen({ orgId: randomId(), leadId, campaignId: campaign, brandIds: [randomId()], subject: "Theirs" });

    const row = await findGenerationForLead({ orgId: randomId(), leadId, campaignId: campaign });
    expect(row).toBeUndefined();
  });

  it("without a campaign, still answers — nothing is inferred, the row names its campaign", async () => {
    const orgId = randomId();
    const leadId = randomId();
    const campaign = randomId();
    await insertGen({ orgId, leadId, campaignId: campaign, brandIds: [randomId()], subject: "Only one" });

    const row = await findGenerationForLead({ orgId, leadId });
    expect(row?.campaignId).toBe(campaign);
  });
});
