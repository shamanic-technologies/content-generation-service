import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { isUniqueViolation } from "../../src/lib/pg-error.js";

// COLD-COPY-RESEND-1126 (drizzle/0056): one FIRST email per (campaign, lead) stays unique; a next message written
// for a person who already holds our email (already_emailed) is an extra row for the same pair.
const ORG = "5d1c0f3e-0000-4000-8000-00000000c126";
const CAMPAIGN = "camp-cold-copy-resend-1126";
const LEAD = "lead-cold-copy-resend-1126";

const row = (alreadyEmailed: boolean) => ({
  orgId: ORG,
  runId: "run-1126",
  promptType: "cold-email-v75",
  brandIds: ["brand-1126"],
  campaignId: CAMPAIGN,
  leadId: LEAD,
  subject: alreadyEmailed ? "Re: Hello" : "Hello",
  sequence: [{ step: 1, bodyText: "x", bodyHtml: "<p>x</p>", daysSinceLastStep: 0 }],
  alreadyEmailed,
});

describe("idx_emailgen_lead after COLD-COPY-RESEND-1126", () => {
  afterAll(async () => {
    await db.delete(emailGenerations).where(eq(emailGenerations.orgId, ORG));
  });

  it("keeps the first email unique, stores next messages beside it", async () => {
    await db.insert(emailGenerations).values(row(false));
    let caught: unknown;
    try {
      await db.insert(emailGenerations).values(row(false));
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught, "idx_emailgen_lead")).toBe(true);

    await db.insert(emailGenerations).values(row(true));
    await db.insert(emailGenerations).values(row(true));
    const all = await db.query.emailGenerations.findMany({ where: and(eq(emailGenerations.orgId, ORG), eq(emailGenerations.leadId, LEAD)) });
    expect(all.map((r) => r.alreadyEmailed).sort()).toEqual([false, true, true]);
  });
});
