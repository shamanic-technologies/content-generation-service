import { Router, Request, Response } from "express";
import { TransferBrandRequestSchema } from "../schemas.js";
import { transferBrand } from "../lib/transfer-brand.js";

const router = Router();

/**
 * POST /internal/transfer-brand
 *
 * Moves every row this service holds for a brand from sourceOrgId to targetOrgId, rewriting the
 * brand id to targetBrandId when given. Table audit + idempotency: src/lib/transfer-brand.ts.
 */
router.post("/internal/transfer-brand", async (req: Request, res: Response) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;
  const result = await transferBrand(parsed.data);

  console.log(
    `[content-generation-service] transfer-brand: ${JSON.stringify(result.updatedTables)} ` +
    `(sourceBrandId=${sourceBrandId}${targetBrandId ? `, targetBrandId=${targetBrandId}` : ""}, ${sourceOrgId} → ${targetOrgId})`
  );

  res.json(result);
});

export default router;
