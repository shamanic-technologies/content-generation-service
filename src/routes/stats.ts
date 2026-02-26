import { Router } from "express";
import { db } from "../db/index.js";
import { emailGenerations, orgs } from "../db/schema.js";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { StatsByModelRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /stats/by-model - Get email generation stats grouped by model
 * No auth — internal network trust (used by campaign-service leaderboard)
 */
router.post("/stats/by-model", async (req, res) => {
  try {
    const parsed = StatsByModelRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }

    const { runIds, orgId, appId, brandId, campaignId } = parsed.data;

    const hasRunIds = Array.isArray(runIds) && runIds.length > 0;

    if (!hasRunIds && !orgId && !appId && !brandId && !campaignId) {
      return res.status(400).json({ error: "At least one filter required: runIds, orgId, appId, brandId, or campaignId" });
    }

    const conditions: SQL[] = [];
    if (hasRunIds) conditions.push(inArray(emailGenerations.runId, runIds!));
    if (appId) conditions.push(eq(emailGenerations.appId, appId));
    if (brandId) conditions.push(eq(emailGenerations.brandId, brandId));
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));

    // If orgId provided, resolve to internal org UUID via lookup
    if (orgId) {
      const org = await db.query.orgs.findFirst({
        where: (o, { eq }) => eq(o.externalOrgId, orgId),
        columns: { id: true },
      });
      if (!org) {
        return res.json({ stats: [] });
      }
      conditions.push(eq(emailGenerations.orgId, org.id));
    }

    // Group email generations by model, counting and collecting runIds
    const results = await db
      .select({
        model: emailGenerations.model,
        count: sql<number>`count(*)::int`,
        runIds: sql<string[]>`array_agg(distinct ${emailGenerations.runId})`,
      })
      .from(emailGenerations)
      .where(and(...conditions))
      .groupBy(emailGenerations.model);

    res.json({
      stats: results.map((r) => ({
        model: r.model,
        count: r.count,
        runIds: r.runIds,
      })),
    });
  } catch (error) {
    console.error("Get stats by model error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
