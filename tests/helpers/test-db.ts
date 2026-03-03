import { db, sql } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  await db.delete(emailGenerations);
}

/**
 * Insert a test email generation
 */
export async function insertTestEmailGeneration(
  orgId: string,
  data: {
    runId?: string;
    apolloEnrichmentId?: string;
    subject?: string;
    bodyText?: string;
    brandId?: string;
    campaignId?: string;
  } = {}
) {
  const [emailGen] = await db
    .insert(emailGenerations)
    .values({
      orgId,
      runId: data.runId || `test-run-${Date.now()}`,
      apolloEnrichmentId: data.apolloEnrichmentId || `test-enrichment-${Date.now()}`,
      subject: data.subject || "Test Subject",
      bodyText: data.bodyText || "Test body content",
      brandId: data.brandId || "test-brand",
      campaignId: data.campaignId || "test-campaign",
    })
    .returning();
  return emailGen;
}

/**
 * Close database connection
 */
export async function closeDb() {
  await sql.end();
}

/**
 * Generate a random UUID
 */
export function randomId(): string {
  return crypto.randomUUID();
}
