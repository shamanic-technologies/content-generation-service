import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { emailGenerations } from "../../src/db/schema.js";
import { fetchWorkflowExamples } from "../../src/lib/examples-query.js";
import { closeDb, randomId } from "../helpers/test-db.js";

const WF = "cold-email-examples-test";
const OTHER_WF = "different-wf";
const seq = [{ step: 1, bodyHtml: "<p>x</p>", bodyText: "x", daysSinceLastStep: 0 }];

// Scope cleanup to THIS suite's workflow rows only. The CI Neon branch clones the parent
// (~15k email_generations rows); a full-table wipe on a cold compute exceeds the hook timeout.
// All assertions here are isolated by the unique WF slug, so a targeted delete is sufficient
// and fast (uses idx_emailgen_workflow).
const cleanup = () => db.delete(emailGenerations).where(inArray(emailGenerations.workflowSlug, [WF, OTHER_WF]));

async function insertGen(opts: {
  orgId: string;
  brandIds: string[];
  workflowSlug?: string;
  subject?: string | null;
  bodyText?: string | null;
  sequence?: unknown;
  createdAt?: Date;
}) {
  const [row] = await db
    .insert(emailGenerations)
    .values({
      orgId: opts.orgId,
      runId: `run-${randomId()}`,
      brandIds: opts.brandIds,
      campaignId: `camp-${randomId()}`,
      workflowSlug: opts.workflowSlug ?? WF,
      subject: opts.subject === undefined ? "Subject" : opts.subject,
      bodyText: opts.bodyText ?? null,
      sequence: opts.sequence === undefined ? null : opts.sequence,
      createdAt: opts.createdAt ?? new Date(),
    })
    .returning();
  return row;
}

// Distinct timestamps so newest-first ordering is deterministic.
const t = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);

describe("fetchWorkflowExamples cascade", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("brand-only: returns brand-tier rows, newest-first", async () => {
    const org = randomId();
    const brand = randomId();
    await insertGen({ orgId: org, brandIds: [brand], subject: "A", createdAt: t(3) });
    await insertGen({ orgId: org, brandIds: [brand], subject: "B", createdAt: t(1) });
    await insertGen({ orgId: org, brandIds: [brand], subject: "C", createdAt: t(2) });

    const rows = await fetchWorkflowExamples({ callerOrgId: org, brandId: brand, workflowSlug: WF, limit: 3 });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.scope === "brand")).toBe(true);
    expect(rows.map((r) => r.subject)).toEqual(["B", "C", "A"]);
  });

  it("brand + org fill: brand-tier first, then same-org other brands", async () => {
    const org = randomId();
    const brand = randomId();
    const otherBrand = randomId();
    await insertGen({ orgId: org, brandIds: [brand], subject: "brand", createdAt: t(5) });
    await insertGen({ orgId: org, brandIds: [otherBrand], subject: "org1", createdAt: t(1) });
    await insertGen({ orgId: org, brandIds: [otherBrand], subject: "org2", createdAt: t(2) });

    const rows = await fetchWorkflowExamples({ callerOrgId: org, brandId: brand, workflowSlug: WF, limit: 3 });

    expect(rows.map((r) => r.scope)).toEqual(["brand", "org", "org"]);
    expect(rows.map((r) => r.subject)).toEqual(["brand", "org1", "org2"]);
  });

  it("global fill: caller has < limit, fills from other orgs", async () => {
    const org = randomId();
    const otherOrg = randomId();
    const brand = randomId();
    const otherBrand = randomId();
    await insertGen({ orgId: org, brandIds: [otherBrand], subject: "org", createdAt: t(1) });
    await insertGen({ orgId: otherOrg, brandIds: [randomId()], subject: "g1", createdAt: t(2) });
    await insertGen({ orgId: otherOrg, brandIds: [randomId()], subject: "g2", createdAt: t(3) });

    const rows = await fetchWorkflowExamples({ callerOrgId: org, brandId: brand, workflowSlug: WF, limit: 3 });

    expect(rows.map((r) => r.scope)).toEqual(["org", "global", "global"]);
    expect(rows.map((r) => r.subject)).toEqual(["org", "g1", "g2"]);
  });

  it("empty: no content-bearing rows for the workflow returns []", async () => {
    const org = randomId();
    const brand = randomId();
    // Different workflow — must not leak in.
    await insertGen({ orgId: org, brandIds: [brand], subject: "other", workflowSlug: OTHER_WF });

    const rows = await fetchWorkflowExamples({ callerOrgId: org, brandId: brand, workflowSlug: WF, limit: 3 });

    expect(rows).toEqual([]);
  });

  it("skips content-less / failed generations; includes sequence-only rows", async () => {
    const org = randomId();
    const brand = randomId();
    // Content-less: null subject + null body + null sequence -> skipped.
    await insertGen({ orgId: org, brandIds: [brand], subject: null, bodyText: null, sequence: null, createdAt: t(1) });
    // Empty subject + empty sequence array -> skipped.
    await insertGen({ orgId: org, brandIds: [brand], subject: "", bodyText: null, sequence: [], createdAt: t(2) });
    // Sequence-only (no subject/body) -> included.
    const kept = await insertGen({ orgId: org, brandIds: [brand], subject: null, bodyText: null, sequence: seq, createdAt: t(3) });

    const rows = await fetchWorkflowExamples({ callerOrgId: org, brandId: brand, workflowSlug: WF, limit: 5 });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(kept.id);
  });

  it("respects limit and never returns an id twice across tiers", async () => {
    const org = randomId();
    const brand = randomId();
    const otherBrand = randomId();
    for (let i = 0; i < 4; i++) await insertGen({ orgId: org, brandIds: [brand], subject: `b${i}`, createdAt: t(10 + i) });
    for (let i = 0; i < 4; i++) await insertGen({ orgId: org, brandIds: [otherBrand], subject: `o${i}`, createdAt: t(20 + i) });

    const rows = await fetchWorkflowExamples({ callerOrgId: org, brandId: brand, workflowSlug: WF, limit: 3 });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.scope === "brand")).toBe(true); // brand tier alone satisfies the limit
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
