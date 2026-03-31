import { Router } from "express";
import { db } from "../db/index.js";
import { emailGenerations } from "../db/schema.js";
import { and, eq, inArray, arrayContains, sql, type SQL } from "drizzle-orm";
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

    const { runIds, orgId, brandId, campaignId } = parsed.data;

    const hasRunIds = Array.isArray(runIds) && runIds.length > 0;

    if (!hasRunIds && !orgId && !brandId && !campaignId) {
      return res.status(400).json({ error: "At least one filter required: runIds, orgId, brandId, or campaignId" });
    }

    const conditions: SQL[] = [];
    if (hasRunIds) conditions.push(inArray(emailGenerations.runId, runIds!));
    if (brandId) conditions.push(arrayContains(emailGenerations.brandIds, [brandId]));
    if (campaignId) conditions.push(eq(emailGenerations.campaignId, campaignId));

    // If orgId provided, filter directly (it's already the internal UUID)
    if (orgId) {
      conditions.push(eq(emailGenerations.orgId, orgId));
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
