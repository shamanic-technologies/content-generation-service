import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/transfer-brand
 *
 * Re-assigns solo-brand email_generations rows from sourceOrgId to targetOrgId.
 * Solo-brand = brand_ids array has exactly one element equal to sourceBrandId.
 * When targetBrandId is provided, also rewrites brand_ids to the target brand.
 * Co-branding rows (multiple brand IDs) are skipped.
 * Idempotent: running twice is a no-op (rows already have targetOrgId).
 */
router.post("/internal/transfer-brand", async (req: Request, res: Response) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  // Step 1: Re-assign org_id on solo-brand rows matching sourceBrandId + sourceOrgId
  const step1 = await db.execute<{ count: string }>(sql`
    UPDATE email_generations
    SET org_id = ${targetOrgId}
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${sourceBrandId}
    RETURNING 1
  `);

  let count = step1.length;

  // Step 2: If targetBrandId provided, rewrite brand_ids on ALL rows still referencing sourceBrandId (no org filter)
  if (targetBrandId) {
    const step2 = await db.execute<{ count: string }>(sql`
      UPDATE email_generations
      SET brand_ids = ARRAY[${targetBrandId}]
      WHERE array_length(brand_ids, 1) = 1
        AND brand_ids[1] = ${sourceBrandId}
      RETURNING 1
    `);
    count += step2.length;
  }

  console.log(
    `[content-generation-service] transfer-brand: updated ${count} email_generations rows ` +
    `(sourceBrandId=${sourceBrandId}${targetBrandId ? `, targetBrandId=${targetBrandId}` : ""}, ${sourceOrgId} → ${targetOrgId})`
  );

  res.json({
    updatedTables: [{ tableName: "email_generations", count }],
  });
});

export default router;
