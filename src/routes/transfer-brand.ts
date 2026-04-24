import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { emailGenerations } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/transfer-brand
 *
 * Re-assigns solo-brand email_generations rows from sourceOrgId to targetOrgId.
 * Solo-brand = brand_ids array has exactly one element equal to brandId.
 * Co-branding rows (multiple brand IDs) are skipped.
 * Idempotent: running twice is a no-op (rows already have targetOrgId).
 */
router.post("/internal/transfer-brand", async (req: Request, res: Response) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }

  const { brandId, sourceOrgId, targetOrgId } = parsed.data;

  // Update email_generations where:
  //   org_id = sourceOrgId
  //   brand_ids has exactly 1 element
  //   that element is brandId
  const result = await db.execute(sql`
    UPDATE email_generations
    SET org_id = ${targetOrgId}
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${brandId}
  `);

  const count = Number(result.rowCount ?? 0);

  console.log(
    `[content-generation-service] transfer-brand: updated ${count} email_generations rows ` +
    `(brandId=${brandId}, ${sourceOrgId} → ${targetOrgId})`
  );

  res.json({
    updatedTables: [{ tableName: "email_generations", count }],
  });
});

export default router;
