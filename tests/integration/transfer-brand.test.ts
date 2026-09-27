import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contentGenerations, emailGenerations, prompts } from "../../src/db/schema.js";
import { transferBrand } from "../../src/lib/transfer-brand.js";
import { closeDb, randomId } from "../helpers/test-db.js";

// Scope cleanup to THIS suite's rows only — the CI database is shared with other suites.
const WF = "transfer-brand-test";
const cleanup = () => db.delete(emailGenerations).where(inArray(emailGenerations.workflowSlug, [WF]));

async function insertGen(orgId: string, brandIds: string[], campaignId: string) {
  const [row] = await db
    .insert(emailGenerations)
    .values({ orgId, runId: `run-${randomId()}`, leadId: randomId(), campaignId, brandIds, workflowSlug: WF })
    .returning();
  return row;
}

async function rowsOf(orgId: string) {
  return db.select().from(emailGenerations).where(eq(emailGenerations.orgId, orgId));
}

describe("transferBrand", () => {
  let sourceOrg: string, targetOrg: string, otherOrg: string;
  let brand: string, otherBrand: string, campaign: string;

  beforeEach(async () => {
    await cleanup();
    sourceOrg = randomId();
    targetOrg = randomId();
    otherOrg = randomId();
    brand = randomId();
    otherBrand = randomId();
    campaign = randomId();
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("moves solo-brand rows and untagged rows of the brand's campaigns; nothing of the brand stays under the source org", async () => {
    await insertGen(sourceOrg, [brand], campaign);
    await insertGen(sourceOrg, [brand], randomId());
    const untagged = await insertGen(sourceOrg, [], campaign);
    const otherBrandRow = await insertGen(sourceOrg, [otherBrand], randomId());
    const untaggedElsewhere = await insertGen(sourceOrg, [], randomId());
    const coBranded = await insertGen(sourceOrg, [brand, otherBrand], randomId());

    const result = await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg });
    expect(result).toEqual({ updatedTables: [{ tableName: "email_generations", count: 3 }] });

    const left = await rowsOf(sourceOrg);
    expect(left.map((r) => r.id).sort()).toEqual([otherBrandRow.id, untaggedElsewhere.id, coBranded.id].sort());
    expect(left.filter((r) => r.brandIds.length === 1 && r.brandIds[0] === brand)).toEqual([]);
    expect(left.find((r) => r.id === untagged.id)).toBeUndefined();

    const moved = await rowsOf(targetOrg);
    expect(moved).toHaveLength(3);
    expect(moved.find((r) => r.id === untagged.id)?.brandIds).toEqual([]);
  });

  it("re-running is a no-op", async () => {
    await insertGen(sourceOrg, [brand], campaign);
    await insertGen(sourceOrg, [], campaign);
    await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg });
    const before = await rowsOf(targetOrg);

    const again = await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg });
    expect(again).toEqual({ updatedTables: [{ tableName: "email_generations", count: 0 }] });
    expect(await rowsOf(targetOrg)).toEqual(before);
  });

  it("rewrites the brand id when targetBrandId is given, and a re-run is a no-op", async () => {
    const targetBrand = randomId();
    await insertGen(sourceOrg, [brand], campaign);
    await insertGen(sourceOrg, [], campaign);

    const first = await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg, targetBrandId: targetBrand });
    expect(first.updatedTables[0].count).toBe(2);
    const moved = await rowsOf(targetOrg);
    expect(moved.map((r) => r.brandIds).sort()).toEqual([[], [targetBrand]]);

    const again = await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg, targetBrandId: targetBrand });
    expect(again.updatedTables[0].count).toBe(0);
  });

  it("never touches another org's rows for the same brand id (brands can be claimed by several orgs)", async () => {
    const targetBrand = randomId();
    const foreign = await insertGen(otherOrg, [brand], randomId());
    await insertGen(sourceOrg, [brand], campaign);

    await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg, targetBrandId: targetBrand });

    const [still] = await rowsOf(otherOrg);
    expect(still.id).toBe(foreign.id);
    expect(still.brandIds).toEqual([brand]);
  });

  it("finishes the brand rewrite on rows an earlier call moved without targetBrandId", async () => {
    const targetBrand = randomId();
    await insertGen(sourceOrg, [brand], campaign);
    await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg });

    const res = await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg, targetBrandId: targetBrand });
    expect(res.updatedTables[0].count).toBe(1);
    expect((await rowsOf(targetOrg))[0].brandIds).toEqual([targetBrand]);
  });

  it("leaves prompts and content_generations alone (no brand or campaign column ties them to a brand)", async () => {
    const type = `transfer-brand-test-${randomId()}`;
    await db.insert(prompts).values({ orgId: sourceOrg, type, prompt: "hi" });
    const [cg] = await db.insert(contentGenerations).values({ orgId: sourceOrg, type: "email", prompt: "hi" }).returning();
    await insertGen(sourceOrg, [brand], campaign);

    await transferBrand({ sourceBrandId: brand, sourceOrgId: sourceOrg, targetOrgId: targetOrg });

    const [p] = await db.select().from(prompts).where(eq(prompts.type, type));
    expect(p.orgId).toBe(sourceOrg);
    const [c] = await db.select().from(contentGenerations).where(eq(contentGenerations.id, cg.id));
    expect(c.orgId).toBe(sourceOrg);

    await db.delete(prompts).where(eq(prompts.type, type));
    await db.delete(contentGenerations).where(eq(contentGenerations.id, cg.id));
  });
});
