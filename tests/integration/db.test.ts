import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { orgs, emailGenerations } from "../../src/db/schema.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestEmailGeneration } from "../helpers/test-db.js";

describe("Email Generation Service Database", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("orgs table", () => {
    it("should create and query an org", async () => {
      const org = await insertTestOrg({ externalOrgId: "org_test123" });
      
      expect(org.id).toBeDefined();
      expect(org.externalOrgId).toBe("org_test123");
    });
  });

  describe("emailGenerations table", () => {
    it("should create an email generation linked to org", async () => {
      const org = await insertTestOrg();
      const emailGen = await insertTestEmailGeneration(org.id, {
        subject: "Test Subject Line",
        bodyText: "Hello, this is a test email.",
      });
      
      expect(emailGen.id).toBeDefined();
      expect(emailGen.subject).toBe("Test Subject Line");
      expect(emailGen.bodyText).toBe("Hello, this is a test email.");
    });

    it("should cascade delete when org is deleted", async () => {
      const org = await insertTestOrg();
      const emailGen = await insertTestEmailGeneration(org.id);
      
      await db.delete(orgs).where(eq(orgs.id, org.id));
      
      const found = await db.query.emailGenerations.findFirst({
        where: eq(emailGenerations.id, emailGen.id),
      });
      expect(found).toBeUndefined();
    });

    it("should store lead and client info", async () => {
      const org = await insertTestOrg();
      const [emailGen] = await db
        .insert(emailGenerations)
        .values({
          orgId: org.id,
          runId: "run_123",
          apolloEnrichmentId: "enrich_456",
          appId: "test-app",
          brandId: "test-brand",
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
