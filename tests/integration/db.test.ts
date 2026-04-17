import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestEmailGeneration } from "../helpers/test-db.js";

describe("Email Generation Service Database", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("emailGenerations table", () => {
    it("should create an email generation", async () => {
      const orgId = crypto.randomUUID();
      const emailGen = await insertTestEmailGeneration(orgId, {
        subject: "Test Subject Line",
        bodyText: "Hello, this is a test email.",
      });

      expect(emailGen.id).toBeDefined();
      expect(emailGen.subject).toBe("Test Subject Line");
      expect(emailGen.bodyText).toBe("Hello, this is a test email.");
    });

    it("should store lead and client info", async () => {
      const orgId = crypto.randomUUID();
      const [emailGen] = await db
        .insert(emailGenerations)
        .values({
          orgId,
          runId: "run_123",
          apolloEnrichmentId: "enrich_456",
          brandIds: ["test-brand"],
          campaignId: "test-campaign",
          leadFirstName: "John",
          leadLastName: "Doe",
          leadCompany: "Acme Corp",
          leadTitle: "CEO",
          clientCompanyName: "Our Company",
          clientCompanyDescription: "We help businesses grow",
          subject: "Partnership Opportunity",
          bodyText: "Hi John, ...",
        })
        .returning();

      expect(emailGen.leadFirstName).toBe("John");
      expect(emailGen.clientCompanyName).toBe("Our Company");
    });
  });
});
